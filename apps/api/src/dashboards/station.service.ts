// Station dashboard (boards "Station dashboard", "Station map", "Station officers", "Station reports",
// "Station roster", "Station messages", "Station settings"). Station heads and dispatchers.
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { WHATSAPP, type WhatsAppAdapter } from '../adapters/whatsapp';

type Kind = 'day' | 'night' | 'off' | 'leave';
const OPEN = `('received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred', 'on_scene', 'closing')`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Monday of the week containing `d`, as YYYY-MM-DD (Lagos time). */
function monday(d = new Date()): string {
  const l = new Date(d.toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const dow = (l.getDay() + 6) % 7;
  l.setDate(l.getDate() - dow);
  return `${l.getFullYear()}-${String(l.getMonth() + 1).padStart(2, '0')}-${String(l.getDate()).padStart(2, '0')}`;
}
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class StationService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(SMS) private readonly sms: SmsAdapter,
    @Inject(WHATSAPP) private readonly whatsapp: WhatsAppAdapter,
  ) {}

  /** The station this person heads or dispatches for (the first, when several). */
  private station(p: Principal, headOnly = false): string {
    const r = p.roles.find((x) => (x.role === 'head' || (!headOnly && x.role === 'dispatcher')) && x.scopeId);
    if (!r) throw new AppError(403, headOnly ? 'head_only' : 'not_station_staff', headOnly ? 'Only the station head can do this.' : 'This page is for station staff.');
    return r.scopeId!;
  }

  // ---------------------------------------------------------------- live incidents (header stats + map)

  async summary(p: Principal) {
    const sid = this.station(p);
    const st = (
      await this.db.query(
        `select s.id, s.name, s.min_on_duty, s.accept_window_seconds, a.name as agency, a.id as agency_id, st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lng, l.postcode
           from stations s join agencies a on a.id = s.agency_id left join locations l on l.id = s.location_id where s.id = $1`,
        [sid],
      )
    ).rows[0];
    const open = (
      await this.db.query(
        `select count(*)::int as n, count(*) filter (where it.severity >= 4 or i.state = 'escalated')::int as critical
           from incidents i join incident_types it on it.code = i.type where i.station_id = $1 and i.state in ${OPEN}`,
        [sid],
      )
    ).rows[0];
    const accept = (
      await this.db.query(
        `select percentile_cont(0.5) within group (order by extract(epoch from (u.accepted_at - u.offered_at))) as s, count(*)::int as n
           from incident_units u where u.station_id = $1 and u.accepted_at > now() - interval '24 hours' and u.role = 'primary'`,
        [sid],
      )
    ).rows[0];
    const officers = (
      await this.db.query(
        `select count(*) filter (where o.on_duty)::int as on_duty,
                count(*) filter (where o.on_duty and o.badge_status = 'verified' and not exists (select 1 from incident_units u where u.officer_id = o.user_id and u.state in ('accepted', 'en_route', 'on_scene')))::int as available,
                count(*)::int as total
           from officers o where o.station_id = $1`,
        [sid],
      )
    ).rows[0];
    const rating = (
      await this.db.query(
        `select round(avg(r.stars)::numeric, 1) as today, (select round(avg(r2.stars)::numeric, 1) from ratings r2 join incidents i2 on i2.id = r2.incident_id where i2.station_id = $1 and r2.created_at > now() - interval '30 days') as month
           from ratings r join incidents i on i.id = r.incident_id where i.station_id = $1 and r.created_at > date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`,
        [sid],
      )
    ).rows[0];
    const reviews = (await this.db.query(`select count(*)::int as n from false_alarm_cases f join incidents i on i.id = f.incident_id where i.station_id = $1 and f.review_state = 'pending'`, [sid])).rows[0].n;
    return {
      station: { id: st.id, name: st.name, agency: st.agency, agencyId: st.agency_id, postcode: st.postcode, location: st.lat != null ? { lat: st.lat, lng: st.lng } : null, minOnDuty: st.min_on_duty },
      stats: {
        open: open.n,
        critical: open.critical,
        medianAcceptS: accept.s == null ? null : Math.round(Number(accept.s)),
        acceptsToday: accept.n,
        onDuty: officers.on_duty,
        available: officers.available,
        officers: officers.total,
        ratingToday: rating.today == null ? null : Number(rating.today),
        ratingMonth: rating.month == null ? null : Number(rating.month),
        falseAlarmReviews: reviews,
      },
    };
  }

  /** Board "Station map": open reports, units and the devices watching the zone (5 km around the station). */
  async map(p: Principal) {
    const sid = this.station(p);
    const s = (await this.db.query(`select l.geom, st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lng, s.name from stations s left join locations l on l.id = s.location_id where s.id = $1`, [sid])).rows[0];
    const incidents = await this.db.query(
      `select i.id, i.type, i.state, i.report_count, l.postcode, st_y(i.geom::geometry) as lat, st_x(i.geom::geometry) as lng, it.severity
         from incidents i join incident_types it on it.code = i.type left join locations l on l.id = i.location_id where i.station_id = $1 and i.state in ${OPEN}`,
      [sid],
    );
    const units = await this.db.query(
      `select o.user_id as id, u.display_name as name, o.badge_no, o.on_duty, st_y(o.last_location::geometry) as lat, st_x(o.last_location::geometry) as lng, o.last_location_at,
              x.state as unit_state, i.type, l.postcode,
              case when o.last_location is not null and i.geom is not null then round(st_distance(o.last_location, i.geom))::int end as distance_m
         from officers o join users u on u.id = o.user_id
         left join incident_units x on x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene')
         left join incidents i on i.id = x.incident_id left join locations l on l.id = i.location_id
        where o.station_id = $1 and (o.on_duty or x.state is not null) order by u.display_name`,
      [sid],
    );
    const devices = s?.geom
      ? await this.db.query(
          `select d.id, d.type, d.name, d.status, d.last_seen, st_y(coalesce(dl.geom, pl.geom)::geometry) as lat, st_x(coalesce(dl.geom, pl.geom)::geometry) as lng, coalesce(dl.postcode, pl.postcode) as postcode
             from devices d left join locations dl on dl.id = d.location_id left join properties pr on pr.id = d.property_id left join locations pl on pl.id = pr.location_id
            where d.type in ('camera', 'street_light') and st_dwithin(coalesce(dl.geom, pl.geom), $1, 5000)`,
          [s.geom],
        )
      : { rows: [] };
    return {
      center: s?.lat != null ? { lat: s.lat, lng: s.lng } : incidents.rows[0] ? { lat: incidents.rows[0].lat, lng: incidents.rows[0].lng } : { lat: 6.6018, lng: 3.3515 },
      // Without a saved building the map centres on the reports, and the station square and zone are not drawn.
      stationPlaced: s?.lat != null,
      zoneRadiusM: 5000,
      incidents: incidents.rows.map((i) => ({ id: i.id, label: `${cap(i.type)}, ${i.postcode ?? 'GPS'}`, state: i.state, severity: i.severity, reports: i.report_count, lat: i.lat, lng: i.lng })),
      units: units.rows.map((u) => ({
        id: u.id,
        name: u.name,
        badgeNo: u.badge_no,
        lat: u.lat,
        lng: u.lng,
        seenAt: u.last_location_at,
        status: u.unit_state ?? (u.on_duty ? 'available' : 'off'),
        line: u.unit_state ? `${u.distance_m != null && u.unit_state !== 'on_scene' ? `${(u.distance_m / 1000).toFixed(1)} km from ` : 'at '}${u.postcode ?? cap(u.type)}` : 'At the station',
      })),
      devices: devices.rows.map((d) => ({ id: d.id, type: d.type, name: d.name, status: d.status, postcode: d.postcode, lat: d.lat, lng: d.lng, lastSeen: d.last_seen })),
    };
  }

  // ---------------------------------------------------------------- officers

  async officers(p: Principal) {
    const sid = this.station(p);
    const r = await this.db.query(
      `select o.user_id as id, u.display_name as name, o.badge_no, o.rank, o.on_duty, o.badge_status, u.created_at as joined,
              exists (select 1 from user_roles ur where ur.user_id = o.user_id and ur.role = 'head' and ur.scope_id = o.station_id) as is_head,
              (select i.type || ', ' || coalesce(l.postcode, 'GPS') from incident_units x join incidents i on i.id = x.incident_id left join locations l on l.id = i.location_id
                where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene') limit 1) as current_task,
              (select round(avg(r.stars)::numeric, 1) from ratings r join incident_units x on x.incident_id = r.incident_id where x.officer_id = o.user_id and x.accepted_at is not null) as rating,
              (select round(avg(extract(epoch from (x.accepted_at - x.offered_at))))::int from incident_units x where x.officer_id = o.user_id and x.accepted_at > now() - interval '30 days') as accept_s,
              (select count(*)::int from incident_units x where x.officer_id = o.user_id and x.accepted_at > date_trunc('month', now())) as answered_month,
              (select coalesce(sum(l.amount_kobo), 0)::bigint from wallet_ledger l join wallets w on w.id = l.wallet_id where w.owner_type = 'user' and w.owner_id = o.user_id and l.type = 'reward' and l.created_at > date_trunc('month', now())) as rewards_month,
              (select r.comment from ratings r join incident_units x on x.incident_id = r.incident_id where x.officer_id = o.user_id and x.accepted_at is not null and r.comment is not null order by r.created_at desc limit 1) as last_comment,
              (select min(ds.starts_at) from duty_shifts ds where ds.officer_id = o.user_id and ds.starts_at > now() and ds.kind in ('day', 'night')) as next_shift
         from officers o join users u on u.id = o.user_id where o.station_id = $1 order by is_head desc, o.on_duty desc, u.display_name`,
      [sid],
    );
    const list = r.rows.map((o) => {
      const status = o.badge_status !== 'verified' ? 'invited' : !o.on_duty ? 'off' : o.current_task ? 'busy' : 'available';
      return {
        id: o.id,
        name: o.name,
        badgeNo: o.badge_no,
        rank: o.rank,
        role: o.is_head ? 'Station head' : 'Officer',
        status,
        onDuty: o.on_duty,
        doingNow: o.badge_status !== 'verified' ? 'Waiting for ID check' : o.current_task ? cap(o.current_task) : o.is_head && o.on_duty ? 'Coordinating' : o.on_duty ? 'At the station' : o.next_shift ? `Shift starts ${new Date(o.next_shift).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}` : 'Off duty',
        rating: o.rating == null ? null : Number(o.rating),
        acceptS: o.accept_s,
        joined: o.joined,
        verified: o.badge_status === 'verified',
        answeredMonth: o.answered_month,
        rewardsMonthKobo: Number(o.rewards_month),
        lastComment: o.last_comment,
      };
    });
    const rated = list.filter((x) => x.rating != null);
    return {
      stats: {
        onDuty: list.filter((x) => x.onDuty).length,
        total: list.length,
        available: list.filter((x) => x.status === 'available').length,
        busy: list.filter((x) => x.status === 'busy').length,
        rating: rated.length ? Number((rated.reduce((a, x) => a + x.rating!, 0) / rated.length).toFixed(1)) : null,
      },
      officers: list,
    };
  }

  /** "Set off duty" / on duty from the dashboard. An officer on a report cannot be set off duty. */
  async setDuty(p: Principal, officerId: string, on: boolean) {
    const sid = this.station(p);
    const o = (await this.db.query(`select o.user_id, u.display_name from officers o join users u on u.id = o.user_id where o.user_id = $1 and o.station_id = $2`, [officerId, sid])).rows[0];
    if (!o) throw new AppError(404, 'not_found', 'Officer not found at your station.');
    if (!on) {
      const busy = await this.db.query(`select 1 from incident_units where officer_id = $1 and state in ('accepted', 'en_route', 'on_scene')`, [officerId]);
      if (busy.rowCount) throw new AppError(409, 'on_a_report', `${o.display_name} is on a report. Reassign it first.`);
    }
    await this.db.query(`update officers set on_duty = $2 where user_id = $1`, [officerId, on]);
    await notify(this.db.pool, [officerId], { type: 'duty_changed', grp: 'team', title: on ? 'You are on duty' : 'You are off duty', body: on ? 'Your station set you on duty. You will get offers.' : 'Your station set you off duty. You will not get offers.', link: '/officer' });
    await this.audit.write({ actorId: p.userId, actorRole: 'head', action: on ? 'officer.on_duty' : 'officer.off_duty', entity: 'officer', entityId: officerId });
    return { message: `${o.display_name} is ${on ? 'on' : 'off'} duty.` };
  }

  /** "Reinforce": the station sends a second officer to a report already taken. They are told at once. */
  async reinforce(p: Principal, incidentId: string, officerId: string) {
    const sid = this.station(p);
    return this.db.tx(async (c) => {
      const i = (await c.query(`select i.id, i.type, i.state, l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1 and i.station_id = $2`, [incidentId, sid])).rows[0];
      if (!i) throw new AppError(404, 'not_found', 'This report could not be found.');
      if (!['accepted', 'en_route', 'on_scene'].includes(i.state)) throw new AppError(409, 'invalid_transition', 'Send reinforcement once a unit has accepted the report.');
      const o = (
        await c.query(
          `select o.user_id, u.display_name, o.on_duty, o.badge_status, exists (select 1 from incident_units x where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene')) as busy
             from officers o join users u on u.id = o.user_id where o.user_id = $1 and o.station_id = $2`,
          [officerId, sid],
        )
      ).rows[0];
      if (!o) throw new AppError(422, 'officer_not_found', 'Choose an officer from your station.');
      if (o.badge_status !== 'verified' || !o.on_duty) throw new AppError(422, 'not_available', `${o.display_name} is not on duty.`);
      if (o.busy) throw new AppError(422, 'officer_busy', `${o.display_name} is already on a report.`);
      await c.query(`insert into incident_units (incident_id, station_id, officer_id, role, state, accepted_at) values ($1, $2, $3, 'reinforcement', 'accepted', now())`, [incidentId, sid, officerId]);
      await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, 'station', 'reinforcement_assigned', $3, true)`, [
        incidentId,
        p.userId,
        { label: 'More help is coming', officerId, staffLabel: `Second unit assigned: ${o.display_name}` },
      ]);
      await notify(c, [officerId], { type: 'reinforcement', grp: 'dispatch', title: 'Reinforce now', body: `Go to ${cap(i.type)} at ${i.postcode ?? 'the GPS location'}. You are the second unit.`, link: `/incidents/${incidentId}` });
      await this.audit.write({ actorId: p.userId, actorRole: 'head', action: 'incident.reinforce', entity: 'incident', entityId: incidentId, payload: { officerId } }, c);
      this.bus.publishIncident({ incidentId, kind: 'reinforce', at: new Date().toISOString() });
      return { message: `${o.display_name} is on the way as the second unit.` };
    });
  }

  /** Units on a report and the reports merged into it (board "Station incident detail"). */
  async incidentExtras(p: Principal, incidentId: string) {
    const sid = this.station(p);
    const ok = await this.db.query(`select 1 from incidents where id = $1 and station_id = $2`, [incidentId, sid]);
    if (!ok.rowCount) throw new AppError(404, 'not_found', 'This report could not be found.');
    const units = await this.db.query(
      `select x.role, x.state, x.offered_at, x.accepted_at, x.offer_expires_at, x.decline_reason, u.display_name, o.badge_no,
              case when o.last_location is not null then round(st_distance(o.last_location, i.geom))::int end as distance_m
         from incident_units x join incidents i on i.id = x.incident_id left join officers o on o.user_id = x.officer_id left join users u on u.id = x.officer_id
        where x.incident_id = $1 order by x.offered_at`,
      [incidentId],
    );
    const reports = await this.db.query(
      `select r.id, r.role, r.source, r.type_chosen, r.answers, r.created_at, u.display_name, coalesce(t.band, 'normal') as band
         from incident_reports r left join users u on u.id = r.reporter_id left join trust_scores t on t.user_id = r.reporter_id
        where r.incident_id = $1 order by r.created_at`,
      [incidentId],
    );
    const notes = await this.db.query(
      `select e.payload->>'text' as text, e.at, u.display_name from incident_events e left join users u on u.id = e.actor_id where e.incident_id = $1 and e.kind = 'note' order by e.at desc`,
      [incidentId],
    );
    return {
      units: units.rows.map((u) => ({
        name: u.display_name,
        badgeNo: u.badge_no,
        role: u.role,
        state: u.state,
        acceptedAt: u.accepted_at,
        offeredAt: u.offered_at,
        secondsLeft: u.state === 'offered' && u.offer_expires_at ? Math.max(0, Math.round((+new Date(u.offer_expires_at) - Date.now()) / 1000)) : null,
        distanceM: u.distance_m,
        declineReason: u.decline_reason,
      })),
      reports: reports.rows.map((r, i) => ({
        id: r.id,
        role: r.role,
        source: r.source,
        type: r.type_chosen,
        detail: r.answers?.situation ?? r.answers?.detail ?? null,
        at: r.created_at,
        who: r.role === 'device' ? 'Camera' : r.display_name ? (i === 0 ? r.display_name : 'Another citizen') : 'Citizen',
        trustBand: r.band,
      })),
      notes: notes.rows.map((n) => ({ text: n.text, at: n.at, by: n.display_name })),
    };
  }

  // ---------------------------------------------------------------- reports

  async reports(p: Principal, days: number) {
    const sid = this.station(p);
    const base = `from incidents i where i.station_id = $1 and i.created_at > now() - make_interval(days => $2) and i.state not in ('pending_cancel', 'merged', 'cancelled')`;
    const totals = (
      await this.db.query(
        `select count(*)::int as n,
                count(*) filter (where i.state in ('resolved', 'unfounded'))::int as closed,
                count(*) filter (where i.state = 'resolved')::int as resolved,
                count(*) filter (where i.state = 'unfounded')::int as unfounded
           ${base}`,
        [sid, days],
      )
    ).rows[0];
    const resp = (
      await this.db.query(
        `select avg(extract(epoch from (x.arrived_at - x.accepted_at))) as s from incident_units x join incidents i on i.id = x.incident_id
          where i.station_id = $1 and x.arrived_at is not null and x.accepted_at > now() - make_interval(days => $2)`,
        [sid, days],
      )
    ).rows[0];
    const byDay = (
      await this.db.query(
        `select extract(isodow from x.accepted_at at time zone 'Africa/Lagos')::int as d, avg(extract(epoch from (x.arrived_at - x.accepted_at))) as s, count(*)::int as n
           from incident_units x join incidents i on i.id = x.incident_id
          where i.station_id = $1 and x.arrived_at is not null and x.accepted_at > now() - make_interval(days => $2) group by 1`,
        [sid, days],
      )
    ).rows;
    const byType = (await this.db.query(`select i.type, count(*)::int as n ${base} group by 1 order by 2 desc`, [sid, days])).rows;
    const ratings = (
      await this.db.query(`select r.stars, count(*)::int as n from ratings r join incidents i on i.id = r.incident_id where i.station_id = $1 and r.created_at > now() - make_interval(days => $2) group by 1`, [sid, days])
    ).rows;
    const recent = (
      await this.db.query(
        `select i.id, i.type, i.state, i.closed_at, l.postcode, i.outcome_code,
                (select extract(epoch from (x.arrived_at - x.accepted_at))::int from incident_units x where x.incident_id = i.id and x.arrived_at is not null order by x.accepted_at limit 1) as response_s,
                (select r.stars from ratings r where r.incident_id = i.id order by r.created_at limit 1) as stars,
                exists (select 1 from incident_events e where e.incident_id = i.id and e.kind = 'transfer') as transferred,
                (select f.review_state from false_alarm_cases f where f.incident_id = i.id) as review
           from incidents i left join locations l on l.id = i.location_id
          where i.station_id = $1 and i.state in ('resolved', 'unfounded') and i.closed_at > now() - make_interval(days => $2) order by i.closed_at desc limit 25`,
        [sid, days],
      )
    ).rows;
    const rated = ratings.reduce((a, r) => a + r.n, 0);
    return {
      days,
      stats: {
        reports: totals.n,
        avgResponseS: resp.s == null ? null : Math.round(Number(resp.s)),
        resolvedPct: totals.closed ? Math.round((totals.resolved / totals.closed) * 100) : null,
        falseAlarmPct: totals.closed ? Math.round((totals.unfounded / totals.closed) * 100) : null,
        rating: rated ? Number((ratings.reduce((a, r) => a + r.stars * r.n, 0) / rated).toFixed(1)) : null,
      },
      byDay: DAYS.map((d, i) => {
        const x = byDay.find((r) => r.d === i + 1);
        return { day: d, avgResponseS: x ? Math.round(Number(x.s)) : null, n: x?.n ?? 0 };
      }),
      byType: byType.map((t) => ({ type: t.type, label: cap(t.type), n: t.n })),
      ratings: [5, 4, 3, 2, 1].map((s) => ({ stars: s, n: ratings.find((r) => r.stars === s)?.n ?? 0 })),
      recent: recent.map((r) => ({
        id: r.id,
        type: cap(r.type),
        postcode: r.postcode,
        closedAt: r.closed_at,
        responseS: r.response_s,
        stars: r.stars,
        outcome: r.state === 'unfounded' ? (r.review === 'overturned' ? 'Overturned' : 'False alarm') : r.transferred ? 'Transferred' : 'Resolved',
      })),
    };
  }

  // ---------------------------------------------------------------- roster

  async roster(p: Principal, week?: string) {
    const sid = this.station(p);
    const start = monday(week ? new Date(`${week}T12:00:00Z`) : new Date());
    const s = (await this.db.query(`select min_on_duty, settings, roster_published_at from stations where id = $1`, [sid])).rows[0];
    const officers = (await this.db.query(`select o.user_id as id, u.display_name as name from officers o join users u on u.id = o.user_id where o.station_id = $1 and o.badge_status = 'verified' order by u.display_name`, [sid])).rows;
    const shifts = await this.db.query(
      `select ds.officer_id, ds.kind, (ds.starts_at at time zone 'Africa/Lagos')::date::text as day from duty_shifts ds join officers o on o.user_id = ds.officer_id
        where o.station_id = $1 and ds.starts_at >= ($2::date - 1) and ds.starts_at < ($2::date + 8)`,
      [sid, start],
    );
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const grid = officers.map((o) => ({
      id: o.id,
      name: o.name,
      days: days.map((d) => shifts.rows.find((x) => x.officer_id === o.id && x.day === d)?.kind ?? 'off'),
    }));
    const perDay = days.map((_, i) => ({ day: grid.filter((g) => g.days[i] === 'day').length, night: grid.filter((g) => g.days[i] === 'night').length }));
    const min = s.min_on_duty as number;
    const gaps = perDay.flatMap((c, i) => [
      ...(c.day < min ? [{ day: DAYS[i], shift: 'day', short: min - c.day, leave: grid.some((g) => g.days[i] === 'leave') }] : []),
      ...(c.night < min ? [{ day: DAYS[i], shift: 'night', short: min - c.night, leave: grid.some((g) => g.days[i] === 'leave') }] : []),
    ]);
    return { week: start, days: days.map((d, i) => ({ date: d, label: DAYS[i] })), officers: grid, perDay, gaps, rules: { dayStart: s.settings.dayStart, nightStart: s.settings.nightStart, minOnDuty: min }, publishedAt: s.roster_published_at };
  }

  /** One cell of the roster: an officer's day, night, off or leave on a date. */
  async setShift(p: Principal, b: { officerId: string; date: string; kind: Kind }) {
    const sid = this.station(p, true);
    const o = await this.db.query(`select 1 from officers where user_id = $1 and station_id = $2`, [b.officerId, sid]);
    if (!o.rowCount) throw new AppError(404, 'not_found', 'Officer not found at your station.');
    await this.db.tx((c) => this.applyShift(c, sid, b.officerId, b.date, b.kind));
    return { ok: true };
  }

  private async applyShift(c: Queryable, sid: string, officerId: string, date: string, kind: Kind) {
    const s = (await c.query(`select settings from stations where id = $1`, [sid])).rows[0].settings;
    await c.query(`delete from duty_shifts where officer_id = $1 and (starts_at at time zone 'Africa/Lagos')::date = $2::date`, [officerId, date]);
    if (kind === 'off') return;
    const startT = kind === 'night' ? s.nightStart : s.dayStart;
    const endT = kind === 'night' ? s.dayStart : s.nightStart;
    await c.query(
      `insert into duty_shifts (officer_id, starts_at, ends_at, kind) values ($1, ($2::date + $3::time) at time zone 'Africa/Lagos',
         (($2::date + case when $4 = 'night' then 1 else 0 end) + $5::time) at time zone 'Africa/Lagos', $4)`,
      [officerId, date, kind === 'leave' ? '00:00' : startT, kind, kind === 'leave' ? '23:59' : endT],
    );
  }

  private async kindOn(c: Queryable, officerId: string, date: string): Promise<Kind> {
    return ((await c.query(`select kind from duty_shifts where officer_id = $1 and (starts_at at time zone 'Africa/Lagos')::date = $2::date limit 1`, [officerId, date])).rows[0]?.kind ?? 'off') as Kind;
  }

  // ---------------------------------------------------------------- swap and leave requests

  /** Officer side: ask to swap a shift with a teammate, or for leave. The station head decides. */
  async request(p: Principal, b: { kind: 'swap' | 'leave'; otherOfficerId?: string; myDate?: string; otherDate?: string; fromDate?: string; toDate?: string; note?: string }) {
    const me = (await this.db.query(`select station_id from officers where user_id = $1`, [p.userId])).rows[0];
    if (!me) throw new AppError(403, 'not_officer', 'For officers.');
    const today = new Date().toISOString().slice(0, 10);
    if (b.kind === 'swap') {
      if (!b.otherOfficerId || !b.myDate || !b.otherDate) throw new AppError(422, 'validation_failed', 'Choose the teammate and both dates.');
      if (b.otherOfficerId === p.userId) throw new AppError(422, 'validation_failed', 'Choose a teammate.');
      const mate = await this.db.query(`select 1 from officers where user_id = $1 and station_id = $2`, [b.otherOfficerId, me.station_id]);
      if (!mate.rowCount) throw new AppError(422, 'validation_failed', 'Choose a teammate from your station.');
      if (b.myDate < today || b.otherDate < today) throw new AppError(422, 'validation_failed', 'Choose dates from today on.');
    } else {
      if (!b.fromDate || !b.toDate || b.toDate < b.fromDate) throw new AppError(422, 'validation_failed', 'Choose the first and last day of leave.');
      if (b.fromDate < today) throw new AppError(422, 'validation_failed', 'Leave starts today or later.');
    }
    const r = await this.db.query(
      `insert into roster_requests (station_id, officer_id, kind, other_officer_id, my_date, other_date, from_date, to_date, note) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [me.station_id, p.userId, b.kind, b.otherOfficerId ?? null, b.myDate ?? null, b.otherDate ?? null, b.fromDate ?? null, b.toDate ?? null, b.note?.trim() || null],
    );
    const heads = (await this.db.query(`select user_id from user_roles where scope_type = 'station' and scope_id = $1 and role = 'head'`, [me.station_id])).rows.map((x) => x.user_id);
    const who = (await this.db.query(`select display_name from users where id = $1`, [p.userId])).rows[0].display_name;
    await notify(this.db.pool, heads, { type: 'roster_request', grp: 'team', title: b.kind === 'swap' ? 'Swap request' : 'Leave request', body: `${who} asked for ${b.kind === 'swap' ? 'a shift swap' : 'leave'}. Decide in Roster.`, link: '/station/roster' });
    if (b.kind === 'swap') await notify(this.db.pool, [b.otherOfficerId!], { type: 'roster_request', grp: 'team', title: 'Shift swap', body: `${who} asked to swap shifts with you. The station head decides.`, link: '/officer/shifts' });
    return { id: r.rows[0].id, message: 'Sent to your station head.' };
  }

  async myRequests(p: Principal) {
    const r = await this.db.query(
      `select q.*, q.my_date::text as my_date, q.other_date::text as other_date, q.from_date::text as from_date, q.to_date::text as to_date, u.display_name as other from roster_requests q left join users u on u.id = q.other_officer_id
        where q.officer_id = $1 or q.other_officer_id = $1 order by q.created_at desc limit 20`,
      [p.userId],
    );
    return r.rows.map((q) => this.describe(q, p.userId));
  }

  private describe(q: Record<string, any>, me?: string) {
    const d = (x: string) => new Date(`${x}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return {
      id: q.id,
      kind: q.kind,
      state: q.state,
      officer: q.officer_name ?? null,
      other: q.other,
      mine: me ? q.officer_id === me : undefined,
      line: q.kind === 'swap' ? `Swap ${d(q.my_date)} for ${d(q.other_date)}${q.other ? ` with ${q.other}` : ''}` : `Leave, ${d(q.from_date)} to ${d(q.to_date)}`,
      note: q.note,
      declineReason: q.decline_reason,
      at: q.created_at,
    };
  }

  async withdraw(p: Principal, id: string) {
    const r = await this.db.query(`update roster_requests set state = 'withdrawn' where id = $1 and officer_id = $2 and state = 'waiting'`, [id, p.userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Request not found.');
    return { message: 'Withdrawn.' };
  }

  async stationRequests(p: Principal) {
    const sid = this.station(p);
    const r = await this.db.query(
      `select q.*, q.my_date::text as my_date, q.other_date::text as other_date, q.from_date::text as from_date, q.to_date::text as to_date, u.display_name as officer_name, o.display_name as other from roster_requests q join users u on u.id = q.officer_id left join users o on o.id = q.other_officer_id
        where q.station_id = $1 and (q.state = 'waiting' or q.decided_at > now() - interval '7 days') order by q.state = 'waiting' desc, q.created_at`,
      [sid],
    );
    return r.rows.map((q) => this.describe(q));
  }

  /** Approve applies it to the roster: a swap trades the two shifts; leave marks each day. */
  async decide(p: Principal, id: string, b: { decision: 'approve' | 'decline'; reason?: string }) {
    const sid = this.station(p, true);
    return this.db.tx(async (c) => {
      const q = (await c.query(`select q.*, q.my_date::text as my_date, q.other_date::text as other_date, q.from_date::text as from_date, q.to_date::text as to_date from roster_requests q where q.id = $1 and q.station_id = $2 for update`, [id, sid])).rows[0];
      if (!q) throw new AppError(404, 'not_found', 'Request not found.');
      if (q.state !== 'waiting') throw new AppError(409, 'decided', 'Already decided.');
      if (b.decision === 'decline' && (b.reason?.trim().length ?? 0) < 3) throw new AppError(422, 'validation_failed', 'Say why, so the officer knows.');
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      if (b.decision === 'approve') {
        if (q.kind === 'swap') {
          const myDate = q.my_date as string;
          const otherDate = q.other_date as string;
          const mine = await this.kindOn(c, q.officer_id, myDate);
          const theirs = await this.kindOn(c, q.other_officer_id, otherDate);
          await this.applyShift(c, sid, q.officer_id, myDate, 'off');
          await this.applyShift(c, sid, q.other_officer_id, myDate, mine);
          await this.applyShift(c, sid, q.other_officer_id, otherDate, 'off');
          await this.applyShift(c, sid, q.officer_id, otherDate, theirs);
        } else {
          for (let d = new Date(`${q.from_date}T12:00:00Z`); d <= new Date(`${q.to_date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) await this.applyShift(c, sid, q.officer_id, iso(d), 'leave');
        }
      }
      await c.query(`update roster_requests set state = $2, decided_by = $3, decided_at = now(), decline_reason = $4 where id = $1`, [id, b.decision === 'approve' ? 'approved' : 'declined', p.userId, b.reason?.trim() || null]);
      const told = [q.officer_id, ...(q.other_officer_id ? [q.other_officer_id] : [])];
      await notify(c, told, {
        type: 'roster_decided',
        grp: 'team',
        title: b.decision === 'approve' ? `${q.kind === 'swap' ? 'Swap' : 'Leave'} approved` : `${q.kind === 'swap' ? 'Swap' : 'Leave'} declined`,
        body: b.decision === 'approve' ? 'The roster is updated. Check your shifts.' : `Reason: ${b.reason!.trim()}`,
        link: '/officer/shifts',
      });
      return { message: b.decision === 'approve' ? 'Approved. The roster is updated.' : 'Declined. The officer is told.' };
    });
  }

  async copyLastWeek(p: Principal, week: string) {
    const sid = this.station(p, true);
    const start = monday(new Date(`${week}T12:00:00Z`));
    await this.db.tx(async (c) => {
      await c.query(`delete from duty_shifts ds using officers o where o.user_id = ds.officer_id and o.station_id = $1 and ds.starts_at >= $2::date and ds.starts_at < $2::date + 7`, [sid, start]);
      await c.query(
        `insert into duty_shifts (officer_id, starts_at, ends_at, kind, vehicle_ref)
         select ds.officer_id, ds.starts_at + interval '7 days', ds.ends_at + interval '7 days', ds.kind, ds.vehicle_ref from duty_shifts ds join officers o on o.user_id = ds.officer_id
          where o.station_id = $1 and ds.starts_at >= $2::date - 7 and ds.starts_at < $2::date`,
        [sid, start],
      );
    });
    return { message: 'Copied last week.' };
  }

  async publish(p: Principal, week: string) {
    const sid = this.station(p, true);
    const start = monday(new Date(`${week}T12:00:00Z`));
    const officers = (await this.db.query(`select user_id from officers where station_id = $1 and badge_status = 'verified'`, [sid])).rows.map((x) => x.user_id);
    await this.db.query(`update stations set roster_published_at = now() where id = $1`, [sid]);
    await notify(this.db.pool, officers, {
      type: 'roster_published',
      grp: 'team',
      title: 'Roster published',
      body: `Your shifts for the week of ${new Date(`${start}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} are ready.`,
      link: '/officer/shifts',
    });
    return { message: `Published. ${officers.length} officers are told.` };
  }

  // ---------------------------------------------------------------- messages

  async messages(p: Principal) {
    const sid = this.station(p);
    const onDuty = (await this.db.query(`select count(*)::int as n from officers where station_id = $1 and on_duty and badge_status = 'verified'`, [sid])).rows[0].n;
    const all = (await this.db.query(`select count(*)::int as n from officers where station_id = $1 and badge_status = 'verified'`, [sid])).rows[0].n;
    const wa = (await this.db.query(`select count(*)::int as n from officers o join users u on u.id = o.user_id where o.station_id = $1 and o.badge_status = 'verified' and u.whatsapp_opt_in`, [sid])).rows[0].n;
    const r = await this.db.query(
      `select m.*, (select count(*)::int from station_broadcast_recipients x where x.message_id = m.id) as total,
              (select count(*)::int from station_broadcast_recipients x where x.message_id = m.id and x.read_at is not null) as read,
              (select count(*)::int from station_broadcast_recipients x where x.message_id = m.id and x.confirmed_at is not null) as confirmed,
              (select count(*)::int from station_broadcast_recipients x where x.message_id = m.id and x.failed_at is not null) as failed
         from station_broadcasts m where m.station_id = $1 order by m.created_at desc limit 20`,
      [sid],
    );
    const officers = (await this.db.query(`select o.user_id as id, u.display_name as name from officers o join users u on u.id = o.user_id where o.station_id = $1 and o.badge_status = 'verified' order by u.display_name`, [sid])).rows;
    return {
      audience: { onDuty, everyone: all, whatsapp: wa },
      officers,
      recent: r.rows.map((m) => ({ id: m.id, title: m.title, body: m.body, urgent: m.urgent, needsConfirm: m.needs_confirm, audience: m.audience, channels: m.channels, total: m.total, read: m.read, confirmed: m.confirmed, failed: m.failed, at: m.created_at })),
    };
  }

  async messageDetail(p: Principal, id: string) {
    const sid = this.station(p);
    const m = (await this.db.query(`select * from station_broadcasts where id = $1 and station_id = $2`, [id, sid])).rows[0];
    if (!m) throw new AppError(404, 'not_found', 'Message not found.');
    const r = await this.db.query(
      `select x.read_at, x.confirmed_at, x.sms_at, x.whatsapp_at, x.failed_at, x.failure, u.display_name, u.id from station_broadcast_recipients x join users u on u.id = x.user_id where x.message_id = $1 order by u.display_name`,
      [id],
    );
    return {
      id,
      title: m.title,
      needsConfirm: m.needs_confirm,
      channels: m.channels,
      smsAfterMinutes: m.sms_after_minutes,
      recipients: r.rows.map((x) => ({ id: x.id, name: x.display_name, readAt: x.read_at, confirmedAt: x.confirmed_at, smsAt: x.sms_at, whatsappAt: x.whatsapp_at, failedAt: x.failed_at, failure: x.failure })),
    };
  }

  async send(
    p: Principal,
    b: { audience: 'on_duty' | 'everyone' | 'officer'; officerId?: string; title: string; body: string; urgent: boolean; needsConfirm: boolean; test?: boolean; sms?: 'off' | 'now' | 'unread'; smsAfterMinutes?: number; whatsapp?: boolean },
  ) {
    const sid = this.station(p);
    const to = b.test
      ? [p.userId]
      : b.audience === 'officer'
        ? (await this.db.query(`select user_id from officers where user_id = $1 and station_id = $2`, [b.officerId ?? null, sid])).rows.map((x) => x.user_id)
        : (await this.db.query(`select user_id from officers where station_id = $1 and badge_status = 'verified'${b.audience === 'on_duty' ? ' and on_duty' : ''}`, [sid])).rows.map((x) => x.user_id);
    if (!to.length) throw new AppError(422, 'no_audience', b.audience === 'officer' ? 'Choose an officer.' : 'Nobody to send to.');
    return this.db.tx(async (c) => {
      const m = (
        await c.query(`insert into station_broadcasts (station_id, sender_id, audience, title, body, urgent, needs_confirm) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [
          sid,
          p.userId,
          b.test ? 'officer' : b.audience,
          b.test ? `[Test] ${b.title}` : b.title,
          b.body,
          b.urgent,
          b.needsConfirm,
        ])
      ).rows[0];
      for (const u of to) await c.query(`insert into station_broadcast_recipients (message_id, user_id) values ($1, $2)`, [m.id, u]);
      // Urgent always texts at once (unless SMS is off); otherwise SMS now, or later to whoever has not opened it.
      const smsMode = b.sms ?? (b.urgent ? 'now' : 'off');
      const channels = ['push', ...(b.whatsapp ? ['whatsapp'] : []), ...(smsMode !== 'off' ? ['sms'] : [])];
      await c.query(`update station_broadcasts set channels = $2, sms_after_minutes = $3 where id = $1`, [m.id, channels, smsMode === 'unread' ? (b.smsAfterMinutes ?? 10) : null]);
      await notify(c, to, { type: 'station_message', grp: b.urgent ? 'dispatch' : 'team', title: b.title, body: b.body.length > 140 ? `${b.body.slice(0, 137)}…` : b.body, link: `/messages/${m.id}` });
      return { id: m.id, to, channels, smsMode };
    }).then(async (r) => {
      // Delivery after commit, so a slow provider never holds the transaction.
      let wa = 0;
      let sms = 0;
      if (r.channels.includes('whatsapp')) wa = await this.deliver(r.id, 'whatsapp', `select u.id, u.phone from users u where u.id = any($1::uuid[]) and u.whatsapp_opt_in and u.phone is not null`, [r.to]);
      if (r.smsMode === 'now') sms = await this.deliver(r.id, 'sms', `select u.id, u.phone from users u where u.id = any($1::uuid[]) and u.phone is not null`, [r.to]);
      const extra = [wa ? `${wa} on WhatsApp` : '', sms ? `${sms} by SMS` : '', r.smsMode === 'unread' ? `SMS to anyone who has not opened it in ${b.smsAfterMinutes ?? 10} min` : ''].filter(Boolean).join(', ');
      return { id: r.id, sent: r.to.length, channels: r.channels, message: b.test ? 'Test sent to you.' : `Sent to ${r.to.length} ${r.to.length === 1 ? 'officer' : 'officers'}${extra ? ` (${extra})` : ''}.` };
    });
  }

  /** Sends one channel to the recipients the query returns; each send or failure is recorded on the recipient. */
  private async deliver(messageId: string, channel: 'sms' | 'whatsapp', sql: string, args: unknown[]): Promise<number> {
    const m = (await this.db.query(`select m.title, m.body, m.urgent, s.name from station_broadcasts m join stations s on s.id = m.station_id where m.id = $1`, [messageId])).rows[0];
    const text = `${m.name}: ${m.title}. ${m.body}`;
    let ok = 0;
    for (const u of (await this.db.query(sql, args)).rows) {
      try {
        if (channel === 'sms') await this.sms.send({ to: u.phone, body: text, urgent: m.urgent });
        else await this.whatsapp.send({ to: u.phone, body: text });
        await this.db.query(`update station_broadcast_recipients set ${channel === 'sms' ? 'sms_at' : 'whatsapp_at'} = now() where message_id = $1 and user_id = $2`, [messageId, u.id]);
        ok++;
      } catch (e) {
        await this.db.query(`update station_broadcast_recipients set failed_at = now(), failure = $3 where message_id = $1 and user_id = $2`, [messageId, u.id, `${channel}: ${(e as Error).message}`]);
      }
    }
    return ok;
  }

  /** Job: "SMS if not opened in n min". */
  async smsFallback(): Promise<number> {
    const due = await this.db.query(
      `select m.id, array_agg(x.user_id) as users from station_broadcasts m join station_broadcast_recipients x on x.message_id = m.id
        where m.sms_after_minutes is not null and m.created_at + make_interval(mins => m.sms_after_minutes) <= now() and m.created_at > now() - interval '1 day'
          and x.read_at is null and x.sms_at is null and x.failed_at is null group by m.id`,
    );
    let n = 0;
    for (const m of due.rows) n += await this.deliver(m.id, 'sms', `select u.id, u.phone from users u where u.id = any($1::uuid[]) and u.phone is not null`, [m.users]);
    return n;
  }

  /** "Resend to unread". */
  async resend(p: Principal, id: string) {
    const sid = this.station(p);
    const m = (await this.db.query(`select * from station_broadcasts where id = $1 and station_id = $2`, [id, sid])).rows[0];
    if (!m) throw new AppError(404, 'not_found', 'Message not found.');
    const unread = (await this.db.query(`select user_id from station_broadcast_recipients where message_id = $1 and read_at is null`, [id])).rows.map((x) => x.user_id);
    await notify(this.db.pool, unread, { type: 'station_message', grp: m.urgent ? 'dispatch' : 'team', title: `Reminder: ${m.title}`, body: m.body.length > 140 ? `${m.body.slice(0, 137)}…` : m.body, link: `/messages/${id}` });
    return { message: unread.length ? `Sent again to ${unread.length} who have not read it.` : 'Everyone has read it.' };
  }

  /** Officer side: open (marks read) and confirm. */
  async officerMessage(p: Principal, id: string, confirm = false) {
    const r = await this.db.query(
      `update station_broadcast_recipients set read_at = coalesce(read_at, now())${confirm ? ', confirmed_at = coalesce(confirmed_at, now())' : ''} where message_id = $1 and user_id = $2 returning read_at, confirmed_at`,
      [id, p.userId],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Message not found.');
    const m = (await this.db.query(`select m.*, u.display_name as sender, s.name as station from station_broadcasts m join users u on u.id = m.sender_id join stations s on s.id = m.station_id where m.id = $1`, [id])).rows[0];
    return { id, title: m.title, body: m.body, urgent: m.urgent, needsConfirm: m.needs_confirm, from: `${m.sender}, ${m.station}`, at: m.created_at, confirmedAt: r.rows[0].confirmed_at };
  }

  // ---------------------------------------------------------------- settings

  async settings(p: Principal) {
    const sid = this.station(p);
    const s = (
      await this.db.query(
        `select s.name, s.phone, s.head_user_id, s.accept_window_seconds, s.min_on_duty, s.settings, l.postcode, a.name as agency
           from stations s join agencies a on a.id = s.agency_id left join locations l on l.id = s.location_id where s.id = $1`,
        [sid],
      )
    ).rows[0];
    const areas = (
      await this.db.query(`select level, area_id as "areaId", coalesce(label, area_id) as label from station_areas where station_id = $1 order by level, label`, [sid])
    ).rows;
    const access = (await this.db.query(`select role, count(*)::int as n from user_roles where scope_type = 'station' and scope_id = $1 group by role`, [sid])).rows;
    const officers = (await this.db.query(`select count(*)::int as n from officers where station_id = $1`, [sid])).rows[0].n;
    const heads = (await this.db.query(`select o.user_id as id, u.display_name as name from officers o join users u on u.id = o.user_id where o.station_id = $1 order by u.display_name`, [sid])).rows;
    return {
      canEdit: hasRole(p, 'head', sid),
      name: s.name,
      agency: s.agency,
      postcode: s.postcode,
      phone: s.phone,
      headUserId: s.head_user_id,
      people: heads,
      acceptWindowSeconds: s.accept_window_seconds,
      minOnDuty: s.min_on_duty,
      settings: s.settings,
      areas,
      access: { head: access.find((a) => a.role === 'head')?.n ?? 0, dispatcher: access.find((a) => a.role === 'dispatcher')?.n ?? 0, officer: officers },
    };
  }

  async saveSettings(
    p: Principal,
    b: { phone?: string; acceptWindowSeconds?: number; minOnDuty?: number; dayStart?: string; nightStart?: string; openingHours?: string; ifNobodyAccepts?: string; alerts?: Record<string, boolean> },
  ) {
    const sid = this.station(p, true);
    if (b.acceptWindowSeconds != null && (b.acceptWindowSeconds < 10 || b.acceptWindowSeconds > 120)) {
      throw new AppError(422, 'validation_failed', 'Give officers between 10 and 120 seconds to accept.', { fields: [{ field: 'acceptWindowSeconds', message: 'Between 10 and 120 seconds.' }] });
    }
    if (b.minOnDuty != null && (b.minOnDuty < 0 || b.minOnDuty > 50)) throw new AppError(422, 'validation_failed', 'Enter a minimum between 0 and 50.');
    const json: Record<string, unknown> = {};
    for (const k of ['dayStart', 'nightStart', 'openingHours', 'ifNobodyAccepts'] as const) if (b[k] !== undefined) json[k] = b[k];
    // Alerts merge one by one, so turning one on never resets the others.
    if (b.alerts) json.alerts = { ...((await this.db.query(`select settings->'alerts' as a from stations where id = $1`, [sid])).rows[0].a ?? {}), ...b.alerts };
    await this.db.query(
      `update stations set phone = coalesce($2, phone), accept_window_seconds = coalesce($3, accept_window_seconds), min_on_duty = coalesce($4, min_on_duty), settings = settings || $5::jsonb where id = $1`,
      [sid, b.phone ?? null, b.acceptWindowSeconds ?? null, b.minOnDuty ?? null, JSON.stringify(json)],
    );
    await this.audit.write({ actorId: p.userId, actorRole: 'head', action: 'station.settings', entity: 'station', entityId: sid, payload: b });
    return { message: 'Saved.' };
  }

  /** "Area this station covers": reports from these places come here first. The head changes it; it is logged. */
  async saveAreas(p: Principal, areas: Array<{ level: 'lga' | 'district' | 'area'; areaId: string; label?: string }>) {
    const sid = this.station(p, true);
    if (!areas.length) throw new AppError(422, 'validation_failed', 'Choose at least one area. Without one, reports only reach you as the nearest station.');
    await this.db.tx(async (c) => {
      const before = (await c.query(`select level, area_id from station_areas where station_id = $1`, [sid])).rows;
      await c.query(`delete from station_areas where station_id = $1`, [sid]);
      for (const a of areas) {
        await c.query(`insert into station_areas (station_id, level, area_id, label) values ($1, $2, $3, $4) on conflict do nothing`, [sid, a.level, a.areaId, a.label ?? null]);
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'head', action: 'station.areas_set', entity: 'station', entityId: sid, payload: { before, after: areas } }, c);
    });
    return { message: 'Area saved. New reports from it come to this station first.' };
  }
}
