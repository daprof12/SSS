// Officer app backend — duty, location and the Home tabs (Rewards doc "Officer
// mobile screens"; States doc officer rows). Copy is the States doc's final wording.
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db } from '../core/db';
import { AppError } from '../core/http';
import { IncidentsService } from '../incidents/incidents.service';

/** Urban driving speed used for the ETA until a routing provider is connected (TRD: maps and routing). */
const URBAN_KMH = 30;
export const etaMinutes = (metres: number) => Math.max(1, Math.round(metres / 1000 / URBAN_KMH * 60));

const ACTIVE = `('accepted', 'en_route', 'on_scene')`;

@Injectable()
export class OfficersService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
  ) {}

  private async officer(p: Principal) {
    const o = (await this.db.query(`select user_id, station_id, on_duty, badge_status from officers where user_id = $1`, [p.userId])).rows[0];
    if (!o) throw new AppError(403, 'not_an_officer', 'This is for officers.');
    return o as { user_id: string; station_id: string; on_duty: boolean; badge_status: string };
  }

  async setDuty(p: Principal, onDuty: boolean, at?: { lat: number; lng: number }) {
    const o = await this.officer(p);
    if (onDuty) {
      if (o.badge_status !== 'verified') throw new AppError(409, 'badge_not_verified', 'You cannot take reports until your badge is verified.');
      if (!at) throw new AppError(422, 'location_required', 'Turn on location to receive offers.');
    } else {
      const busy = await this.db.query(`select 1 from incident_units where officer_id = $1 and state in ${ACTIVE} limit 1`, [p.userId]);
      if (busy.rowCount) throw new AppError(409, 'active_incident', 'You still have an active incident. Hand it over before going off duty.');
      // Open offers go straight back to routing rather than expiring on someone who left.
      const open = await this.db.query(`select incident_id from incident_units where officer_id = $1 and state = 'offered'`, [p.userId]);
      for (const r of open.rows) await this.incidents.decline(p, r.incident_id, 'off_duty').catch(() => undefined);
    }
    await this.db.query(
      `update officers set on_duty = $2,
              last_location = coalesce(st_setsrid(st_makepoint($4, $3), 4326)::geography, last_location),
              last_location_at = case when $3::float8 is null then last_location_at else now() end
        where user_id = $1`,
      [p.userId, onDuty, at?.lat ?? null, at?.lng ?? null],
    );
    await this.audit.write({ actorId: p.userId, actorRole: 'officer', action: onDuty ? 'officer.on_duty' : 'officer.off_duty', entity: 'officer', entityId: p.userId });
    return { onDuty, message: onDuty ? 'You are on duty. You will be told first about reports near you.' : 'You are off duty. You will not get offers.' };
  }

  /** Location ping from the officer app. Updates the citizen's ETA while en route. */
  async updateLocation(p: Principal, lat: number, lng: number) {
    await this.officer(p);
    await this.db.query(`update officers set last_location = st_setsrid(st_makepoint($3, $2), 4326)::geography, last_location_at = now() where user_id = $1`, [p.userId, lat, lng]);
    const units = await this.db.query(
      `select i.id, i.eta_minutes, st_distance(i.geom, st_setsrid(st_makepoint($3, $2), 4326)::geography) as d
         from incident_units u join incidents i on i.id = u.incident_id
        where u.officer_id = $1 and u.state in ('accepted', 'en_route') and i.state in ('accepted', 'en_route')`,
      [p.userId, lat, lng],
    );
    const changed: string[] = [];
    for (const u of units.rows) {
      const eta = etaMinutes(Number(u.d));
      if (eta !== u.eta_minutes) {
        await this.db.query(`update incidents set eta_minutes = $2 where id = $1`, [u.id, eta]);
        // Log only meaningful moves, so the response log stays readable.
        if (u.eta_minutes == null || Math.abs(eta - u.eta_minutes) >= 5) {
          await this.db.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload) values ($1, $2, 'officer', 'eta_changed', $3)`, [u.id, p.userId, { from: u.eta_minutes, to: eta }]);
        }
        changed.push(u.id);
      }
      // Moving location is part of the live view even when the ETA minute holds.
      this.bus.publishIncident({ incidentId: u.id, kind: 'location', at: new Date().toISOString() });
    }
    return { ok: true, etaUpdated: changed.length };
  }

  /** Officer Home: duty, today's totals and the Offers / Active / Team / Done tabs. */
  async home(p: Principal) {
    const o = await this.officer(p);
    const [stats, offers, active, team, done] = await Promise.all([
      this.db.query(
        `select count(*) filter (where i.closed_at::date = current_date)::int as today,
                avg(extract(epoch from (u.arrived_at - u.accepted_at))) filter (where u.arrived_at is not null) as avg_arrival_s,
                (select round(avg(r.stars)::numeric, 1) from ratings r join incident_units x on x.incident_id = r.incident_id where x.officer_id = $1) as rating
           from incident_units u join incidents i on i.id = u.incident_id where u.officer_id = $1`,
        [p.userId],
      ),
      this.db.query(
        `select i.id, i.type, l.postcode, l.area_label, u.offer_expires_at,
                round(st_distance(o.last_location, i.geom))::int as distance_m
           from incident_units u join incidents i on i.id = u.incident_id
           join officers o on o.user_id = u.officer_id left join locations l on l.id = i.location_id
          where u.officer_id = $1 and u.state = 'offered' and u.offer_expires_at > now() order by u.offer_expires_at`,
        [p.userId],
      ),
      this.db.query(
        `select i.id, i.type, i.state, l.postcode, l.area_label, i.eta_minutes, u.accepted_at
           from incident_units u join incidents i on i.id = u.incident_id left join locations l on l.id = i.location_id
          where u.officer_id = $1 and u.state in ${ACTIVE} order by u.accepted_at`,
        [p.userId],
      ),
      this.db.query(
        `select distinct on (i.id) i.id, i.type, i.state, l.postcode, ou.display_name as officer
           from incident_units u join incidents i on i.id = u.incident_id
           join users ou on ou.id = u.officer_id left join locations l on l.id = i.location_id
          where u.station_id = $1 and u.officer_id <> $2 and u.state in ${ACTIVE}`,
        [o.station_id, p.userId],
      ),
      this.db.query(
        `select distinct on (i.id) i.id, i.type, i.state, l.postcode, i.closed_at, r.stars
           from incident_units u join incidents i on i.id = u.incident_id left join locations l on l.id = i.location_id
           left join ratings r on r.incident_id = i.id
          where u.officer_id = $1 and u.accepted_at is not null and i.state in ('resolved', 'unfounded') and i.closed_at::date = current_date`,
        [p.userId],
      ),
    ]);
    const s = stats.rows[0];
    const avg = s.avg_arrival_s == null ? null : Math.round(Number(s.avg_arrival_s));
    return {
      onDuty: o.on_duty,
      badgeVerified: o.badge_status === 'verified',
      banner: !o.on_duty ? 'You are off duty. Go on duty to receive offers.' : o.badge_status !== 'verified' ? 'You cannot take reports until your badge is verified.' : null,
      today: { closed: s.today, avgArrival: avg == null ? null : `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`, rating: s.rating ? Number(s.rating) : null },
      tabs: {
        offers: { items: offers.rows.map((r) => ({ ...r, secondsLeft: Math.max(0, Math.round((new Date(r.offer_expires_at).getTime() - Date.now()) / 1000)) })), empty: 'No offers right now. Stay on duty and keep the app open.' },
        active: { items: active.rows, empty: 'You are not on a report.' },
        team: { items: team.rows, empty: 'No one on your team is on a report.' },
        done: { items: done.rows, empty: 'No finished reports today.' },
      },
    };
  }
}
