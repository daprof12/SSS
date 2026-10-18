// Officer app beyond dispatch (boards: Officer history and team ratings, activity detail,
// team, profile and rating, report and tip). "Team" is the officer's station.
import { formatNaira, subRatings } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { POSTCODE, PostcodeUnavailable, type PostcodeAdapter } from '../adapters/postcode';
import type { Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db } from '../core/db';
import { AppError } from '../core/http';

const OUTCOME: Record<string, string> = {
  arrest: 'Arrest made',
  suspect_fled: 'Suspect fled',
  victim_assisted: 'Victim assisted',
  fire_extinguished: 'Fire put out',
  patient_transported: 'Patient taken to hospital',
  resolved_on_scene: 'Resolved on scene',
  unfounded: 'Unfounded',
  malicious: 'False alarm',
};
const ROLE: Record<string, string> = { primary: 'Lead', reinforcement: 'Support', parallel: 'Support', transfer: 'Took over' };
const CLOSED = `('resolved', 'unfounded')`;

@Injectable()
export class OfficerWorkService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
  ) {}

  private async officer(p: Principal) {
    const o = (
      await this.db.query(
        `select o.*, s.name as station_name, a.name as agency_name, a.id as agency_id, u.display_name
           from officers o join stations s on s.id = o.station_id join agencies a on a.id = s.agency_id join users u on u.id = o.user_id
          where o.user_id = $1`,
        [p.userId],
      )
    ).rows[0];
    if (!o) throw new AppError(403, 'not_an_officer', 'This is for officers.');
    return o;
  }

  private async ratingsFor(officerIds: string[]) {
    const r = await this.db.query(
      `select distinct x.officer_id, r.incident_id, r.stars, r.tags from ratings r join incident_units x on x.incident_id = r.incident_id
        where x.officer_id = any($1::uuid[]) and x.accepted_at is not null`,
      [officerIds],
    );
    const by = new Map<string, { stars: number; tags: string[] }[]>();
    for (const row of r.rows) by.set(row.officer_id, [...(by.get(row.officer_id) ?? []), { stars: row.stars, tags: row.tags }]);
    return by;
  }

  // ---------------------------------------------------------------- History

  /** Board "Officer history": station responses, with mine marked; filters All, Mine, Team, This month. */
  async history(p: Principal, filter: 'all' | 'mine' | 'team' | 'month') {
    const o = await this.officer(p);
    const rows = (
      await this.db.query(
        `select i.id, i.type, t.label as type_label, i.state, i.closed_at, i.created_at, l.postcode, r.stars,
                coalesce(json_agg(json_build_object('id', u.officer_id, 'name', ou.display_name) order by u.offered_at) filter (where u.officer_id is not null), '[]') as officers
           from incidents i join incident_types t on t.code = i.type
           join incident_units u on u.incident_id = i.id and u.accepted_at is not null
           left join users ou on ou.id = u.officer_id
           left join locations l on l.id = i.location_id
           left join ratings r on r.incident_id = i.id
          where u.station_id = $1 and i.state in ${CLOSED} and i.closed_at > now() - interval '90 days'
          group by i.id, t.label, l.postcode, r.stars
          order by i.closed_at desc limit 200`,
        [o.station_id],
      )
    ).rows;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const items = rows
      .map((r) => {
        const people: { id: string; name: string }[] = [...new Map((r.officers as { id: string; name: string }[]).map((x) => [x.id, x])).values()];
        const mine = people.some((x) => x.id === p.userId);
        const names = people.map((x) => (x.id === p.userId ? 'You' : x.name)).sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
        return {
          id: r.id as string,
          type: r.type as string,
          title: `${r.type_label}${r.postcode ? `, ${r.postcode}` : ''}`,
          people: names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', '),
          officerCount: names.length,
          mine,
          closedAt: r.closed_at as Date,
          resolved: r.state === 'resolved',
          stars: r.stars as number | null,
        };
      })
      .filter((x) => (filter === 'mine' ? x.mine : filter === 'team' ? !x.mine : filter === 'month' ? new Date(x.closedAt) >= monthStart : true));
    const team = (await this.db.query(`select user_id from officers where station_id = $1`, [o.station_id])).rows.map((x) => x.user_id);
    const ratings = await this.ratingsFor(team);
    const all = [...ratings.values()].flat();
    return {
      stats: {
        responses: rows.filter((r) => (r.officers as { id: string }[]).some((x) => x.id === p.userId)).length,
        myRating: subRatings(ratings.get(p.userId) ?? []).overall,
        teamRating: subRatings(all).overall,
      },
      items,
    };
  }

  /** Board "Officer activity detail": facts, team with each officer's rating, and the citizen's comment. */
  async historyDetail(p: Principal, id: string) {
    const o = await this.officer(p);
    const i = (
      await this.db.query(
        `select i.*, t.label as type_label, l.postcode, r.stars, r.comment from incidents i join incident_types t on t.code = i.type
           left join locations l on l.id = i.location_id left join ratings r on r.incident_id = i.id
          where i.id = $1 and exists (select 1 from incident_units u where u.incident_id = i.id and u.station_id = $2 and u.accepted_at is not null)`,
        [id, o.station_id],
      )
    ).rows[0];
    if (!i) throw new AppError(404, 'not_found', 'This response is not in your station’s history.');
    const units = (
      await this.db.query(
        `select distinct on (u.officer_id) u.officer_id, u.role, u.accepted_at, u.arrived_at, ou.display_name
           from incident_units u join users ou on ou.id = u.officer_id where u.incident_id = $1 and u.accepted_at is not null order by u.officer_id, u.accepted_at`,
        [id],
      )
    ).rows.sort((a, b) => +new Date(a.accepted_at) - +new Date(b.accepted_at));
    const ratings = await this.ratingsFor(units.map((u) => u.officer_id));
    const rewards = (
      await this.db.query(
        `select w.owner_id as officer_id, sum(l.amount_kobo)::bigint as kobo, min(l.available_at) as at from wallet_ledger l join wallets w on w.id = l.wallet_id
          where l.type = 'reward' and l.reference = $1 and l.amount_kobo > 0 group by w.owner_id`,
        [`incident:${id}`],
      )
    ).rows;
    const reward = new Map(rewards.map((r) => [r.officer_id, Number(r.kobo)]));
    const lead = units.find((u) => u.role === 'primary') ?? units[0];
    const arrivalS = lead?.arrived_at && lead.accepted_at ? Math.round((+new Date(lead.arrived_at) - +new Date(lead.accepted_at)) / 1000) : null;
    const total = rewards.reduce((s, r) => s + Number(r.kobo), 0);
    return {
      id,
      title: `${i.type_label}${i.postcode ? `, ${i.postcode}` : ''}`,
      stars: i.stars as number | null,
      date: (i.closed_at ?? i.created_at) as Date,
      arrivalS,
      reportsMerged: i.report_count as number,
      outcome: OUTCOME[i.outcome_code] ?? (i.state === 'resolved' ? 'Resolved' : 'Unfounded'),
      resolved: i.state === 'resolved',
      team: units.map((u) => ({
        name: u.officer_id === p.userId ? 'You' : u.display_name,
        you: u.officer_id === p.userId,
        role: ROLE[u.role] ?? 'Support',
        rating: subRatings(ratings.get(u.officer_id) ?? []).overall,
        rewardKobo: reward.get(u.officer_id) ?? null,
      })),
      comment: (i.comment as string | null) ?? null,
      rewardNote: total ? `Reward ${formatNaira(total)} split by the ${o.station_name} rule. Paid to wallets on ${new Date(rewards[0].at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.` : null,
    };
  }

  // ---------------------------------------------------------------- Team

  /** Board "Officer team": members with duty and rating, upcoming shifts, and recent activity. */
  async team(p: Principal) {
    const o = await this.officer(p);
    const members = (
      await this.db.query(
        `select o.user_id, o.on_duty, o.rank, u.display_name,
                (select min(starts_at) from duty_shifts d where d.officer_id = o.user_id and d.kind in ('day', 'night') and d.starts_at > now()) as next_shift
           from officers o join users u on u.id = o.user_id where o.station_id = $1 order by o.on_duty desc, u.display_name`,
        [o.station_id],
      )
    ).rows;
    const ratings = await this.ratingsFor(members.map((m) => m.user_id));
    const stats = (
      await this.db.query(
        `select count(distinct u.incident_id)::int as responses,
                avg(extract(epoch from (u.arrived_at - u.accepted_at))) filter (where u.arrived_at is not null and u.role = 'primary') as avg_s
           from incident_units u join incidents i on i.id = u.incident_id where u.station_id = $1 and u.accepted_at is not null and i.state in ${CLOSED}`,
        [o.station_id],
      )
    ).rows[0];
    const shifts = (
      await this.db.query(
        `select d.officer_id, u.display_name, d.starts_at, d.ends_at, d.kind, d.vehicle_ref from duty_shifts d join officers o on o.user_id = d.officer_id join users u on u.id = d.officer_id
          where o.station_id = $1 and d.ends_at > now() and d.starts_at < now() + interval '7 days' order by d.starts_at limit 40`,
        [o.station_id],
      )
    ).rows;
    const activity = (
      await this.db.query(
        `select e.kind, e.payload, e.at, t.label as type_label, l.postcode, ou.display_name as actor
           from incident_events e join incidents i on i.id = e.incident_id join incident_types t on t.code = i.type
           left join locations l on l.id = i.location_id left join users ou on ou.id = e.actor_id
          where i.station_id = $1 and e.kind in ('accept', 'arrive', 'close_valid', 'close_unfounded', 'reinforce', 'note') and e.at > now() - interval '7 days'
          order by e.at desc limit 30`,
        [o.station_id],
      )
    ).rows;
    const VERB: Record<string, string> = { accept: 'accepted', arrive: 'arrived at', close_valid: 'closed', close_unfounded: 'closed as unfounded', reinforce: 'asked for reinforcement at', note: 'added a note on' };
    return {
      name: o.station_name as string,
      agency: o.agency_name as string,
      stats: { rating: subRatings([...ratings.values()].flat()).overall, responses: stats.responses as number, avgArrivalS: stats.avg_s == null ? null : Math.round(Number(stats.avg_s)) },
      members: members.map((m) => ({
        id: m.user_id,
        name: m.user_id === p.userId ? 'You' : m.display_name,
        you: m.user_id === p.userId,
        rank: m.rank as string | null,
        onDuty: m.on_duty as boolean,
        backAt: m.on_duty ? null : (m.next_shift as Date | null),
        rating: subRatings(ratings.get(m.user_id) ?? []).overall,
      })),
      shifts: shifts.map((s) => ({ name: s.officer_id === p.userId ? 'You' : s.display_name, you: s.officer_id === p.userId, startsAt: s.starts_at, endsAt: s.ends_at, kind: s.kind, vehicle: s.vehicle_ref })),
      activity: activity.map((a) => ({ at: a.at, text: `${a.actor ?? 'Station'} ${VERB[a.kind] ?? a.kind} ${a.type_label}${a.postcode ? `, ${a.postcode}` : ''}` })),
    };
  }

  // ---------------------------------------------------------------- Profile

  /** Board "Officer profile and rating". */
  async profile(p: Principal) {
    const o = await this.officer(p);
    const ratings = await this.ratingsFor([p.userId]);
    const mine = subRatings(ratings.get(p.userId) ?? []);
    const team = (await this.db.query(`select user_id from officers where station_id = $1`, [o.station_id])).rows.map((x) => x.user_id);
    const teamRatings = await this.ratingsFor(team);
    const wallet = (
      await this.db.query(
        `select coalesce(b.available_kobo, 0)::bigint as available, coalesce(b.held_kobo, 0)::bigint as held from wallets w left join wallet_balances b on b.wallet_id = w.id where w.owner_type = 'user' and w.owner_id = $1`,
        [p.userId],
      )
    ).rows[0];
    const earned = (
      await this.db.query(
        `select coalesce(sum(l.amount_kobo), 0)::bigint as k from wallet_ledger l join wallets w on w.id = l.wallet_id
          where w.owner_type = 'user' and w.owner_id = $1 and l.type in ('reward', 'donation_in') and l.amount_kobo > 0`,
        [p.userId],
      )
    ).rows[0].k;
    const bank = (await this.db.query(`select bank_name, last_four, verified_at from bank_accounts where owner_type = 'user' and owner_id = $1 and removed_at is null order by created_at desc limit 1`, [p.userId])).rows[0];
    const tips = (await this.db.query(`select count(*)::int as n from tips where user_id = $1`, [p.userId])).rows[0].n;
    return {
      name: o.display_name as string,
      agency: o.agency_name as string,
      station: o.station_name as string,
      serviceNo: o.badge_no as string,
      rank: o.rank as string | null,
      badge: { status: o.badge_status as string, expiresOn: o.badge_expires_on as string | null },
      rating: mine,
      team: { name: o.station_name as string, officers: team.length, rating: subRatings([...teamRatings.values()].flat()).overall },
      wallet: { availableKobo: Number(wallet?.available ?? 0), heldKobo: Number(wallet?.held ?? 0) },
      rewardsAndDonationsKobo: Number(earned),
      bank: bank ? { name: bank.bank_name as string, lastFour: bank.last_four as string, verified: !!bank.verified_at } : null,
      tips: tips as number,
      onDuty: o.on_duty as boolean,
    };
  }

  /** "Duty and shifts": my next two weeks. */
  async shifts(p: Principal) {
    const o = await this.officer(p);
    const rows = (
      await this.db.query(`select starts_at, ends_at, kind, vehicle_ref from duty_shifts where officer_id = $1 and ends_at > now() and starts_at < now() + interval '14 days' order by starts_at`, [p.userId])
    ).rows;
    return { onDuty: o.on_duty as boolean, shifts: rows.map((s) => ({ startsAt: s.starts_at, endsAt: s.ends_at, kind: s.kind, vehicle: s.vehicle_ref })) };
  }

  // ---------------------------------------------------------------- Field reports

  /** Incidents the officer can link a field report to: ones they are on, or closed in the last day. */
  async linkable(p: Principal) {
    await this.officer(p);
    const r = await this.db.query(
      `select distinct on (i.id) i.id, t.label as type_label, l.postcode, i.state, u.accepted_at from incident_units u join incidents i on i.id = u.incident_id
         join incident_types t on t.code = i.type left join locations l on l.id = i.location_id
        where u.officer_id = $1 and u.accepted_at is not null and (i.closed_at is null or i.closed_at > now() - interval '1 day')
        order by i.id, u.accepted_at desc`,
      [p.userId],
    );
    return r.rows.map((x) => ({ id: x.id, title: `${x.type_label}${x.postcode ? `, ${x.postcode}` : ''}`, live: !['resolved', 'unfounded', 'cancelled', 'merged'].includes(x.state) }));
  }

  async fileReport(p: Principal, b: { type: string; description: string; postcode?: string; lat?: number; lng?: number; incidentId?: string; clientRef: string }) {
    const o = await this.officer(p);
    const prior = (await this.db.query(`select id from field_reports where client_ref = $1 and officer_id = $2`, [b.clientRef, p.userId])).rows[0];
    if (prior) return { id: prior.id, duplicate: true };
    if (b.description.trim().length < 10) throw new AppError(422, 'validation_failed', 'Say what you saw in a sentence or two.', { fields: [{ field: 'description', message: 'Say what you saw in a sentence or two.' }] });
    let locationId: string | null = null;
    if (b.postcode) {
      let building;
      try {
        building = await this.postcode.lookup(b.postcode);
      } catch (e) {
        if (!(e instanceof PostcodeUnavailable)) throw e;
      }
      if (!building && (b.lat == null || b.lng == null)) throw new AppError(422, 'postcode_not_found', 'We could not find that building. Pick it on the map.', { fields: [{ field: 'where', message: 'Pick the building on the map.' }] });
      if (building) {
        locationId = (
          await this.db.query(
            `insert into locations (postcode, building_name, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
             values ($1, $2, $3, $4, $5, $6, $7, $8, st_setsrid(st_makepoint($9, $10), 4326)::geography)
             on conflict (postcode) do update set fetched_at = now() returning id`,
            [building.postcode, building.name ?? null, building.address, building.stateId, building.lgaId, building.districtId, building.areaId, building.areaLabel, building.lng, building.lat],
          )
        ).rows[0].id;
      }
    }
    if (!locationId && (b.lat == null || b.lng == null)) throw new AppError(422, 'location_required', 'Add where it is: pick the building on the map.', { fields: [{ field: 'where', message: 'Add where it is.' }] });
    if (b.incidentId) {
      const ok = await this.db.query(`select 1 from incident_units where incident_id = $1 and officer_id = $2 and accepted_at is not null`, [b.incidentId, p.userId]);
      if (!ok.rowCount) throw new AppError(422, 'not_linkable', 'You can only link incidents you responded to.');
    }
    const r = await this.db.tx(async (c) => {
      const row = (
        await c.query(
          `insert into field_reports (officer_id, station_id, type, location_id, geom, description, incident_id, client_ref)
           values ($1, $2, $3, $4, case when $5::float8 is null then null else st_setsrid(st_makepoint($6, $5), 4326)::geography end, $7, $8, $9) returning id`,
          [p.userId, o.station_id, b.type, locationId, b.lat ?? null, b.lng ?? null, b.description.trim(), b.incidentId ?? null, b.clientRef],
        )
      ).rows[0];
      if (b.incidentId) {
        await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload) values ($1, $2, 'officer', 'field_report', $3)`, [
          b.incidentId,
          p.userId,
          { label: 'Field report added', reportId: row.id, text: b.description.trim().slice(0, 280) },
        ]);
      }
      return row;
    });
    if (b.incidentId) this.bus.publishIncident({ incidentId: b.incidentId, kind: 'field_report', at: new Date().toISOString() });
    return { id: r.id, duplicate: false, linked: !!b.incidentId };
  }

  async myReports(p: Principal) {
    await this.officer(p);
    const r = await this.db.query(
      `select f.id, f.description, f.created_at, f.incident_id, t.label as type_label, l.postcode,
              (select count(*)::int from media m where m.owner_type = 'field_report' and m.owner_id = f.id and m.state = 'ready') as files
         from field_reports f join incident_types t on t.code = f.type left join locations l on l.id = f.location_id
        where f.officer_id = $1 order by f.created_at desc limit 50`,
      [p.userId],
    );
    return r.rows.map((x) => ({ id: x.id, title: `${x.type_label}${x.postcode ? `, ${x.postcode}` : ''}`, description: x.description, at: x.created_at, linked: !!x.incident_id, files: x.files }));
  }
}
