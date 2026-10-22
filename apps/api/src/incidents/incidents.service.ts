import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  applyIncidentEvent,
  assessReporterCancel,
  dispatchingAgencyStates,
  incidentTimers,
  sideEventAllowedIn,
  type IncidentActor,
  type IncidentEvent,
  type IncidentSideEvent,
  type IncidentState,
} from '@erp/domain';
import { POSTCODE, PostcodeUnavailable, type Building, type PostcodeAdapter } from '../adapters/postcode';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { Audit } from '../core/audit';
import { RewardsService } from '../rewards/rewards.service';
import { hasRole, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { CONFIG, type AppConfig } from '../core/config';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { FinesService } from '../citizen/fines.service';
import { IncidentRepo, type IncidentRow } from './incident.repo';

/** Citizen-facing timeline labels; events not listed here stay internal. */
const PUBLIC_LABELS: Partial<Record<string, string>> = {
  window_elapsed: 'Report received',
  route: 'Sent to the nearest team',
  assign: 'Sent to a team',
  direct_assign: 'Help accepted',
  reassign: 'Changing officers',
  cant_go: 'Changing teams',
  offer_timeout: 'Passed to the next team',
  reoffer: 'Sent to another officer',
  accept: 'Help accepted',
  start_route: 'On the way',
  officer_drop: 'Changing teams',
  transfer: 'Passed to another unit',
  arrive: 'Help has arrived',
  close_valid: 'Report closed',
  close_unfounded: 'Report closed',
  reporter_cancel: 'You cancelled this report',
  cancel_in_window: 'Cancelled before sending',
  report_joined: 'Someone else reported this too',
  reinforce: 'More help is coming',
};

export const CANT_GO_LABELS: Record<string, string> = {
  already_busy: 'Already on another job',
  vehicle: 'No vehicle, or it broke down',
  unsafe: 'Not safe to go alone',
  too_far: 'Too far away',
  unwell: 'Unwell or injured',
  other: 'Other',
};

const DECLINE_LABELS: Record<string, string> = { busy: 'Busy on another incident', too_far: 'Too far away', off_duty: 'Going off duty', other: 'Other' };

const MERGE_RADIUS_M = 100;
const MERGE_WINDOW_MIN = 15;

export interface CreateIncidentInput {
  type: string;
  postcode?: string;
  lat?: number;
  lng?: number;
  clientRef: string;
  discreet?: boolean;
}

@Injectable()
export class IncidentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Incidents');
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(IncidentRepo) private readonly repo: IncidentRepo,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
    @Inject(SMS) private readonly sms: SmsAdapter,
    @Inject(RewardsService) private readonly rewards: RewardsService,
    @Inject(FinesService) private readonly fines: FinesService,
  ) {}

  onModuleInit() {
    // Tests sweep on demand; everywhere else straight away (timers from before a restart are gone)
    // and then every few seconds.
    if (this.config.env === 'test') return;
    const every = Number(process.env.SWEEP_MS ?? 5000);
    const tick = () => this.sweepOverdue().catch((e) => this.log.error(`sweep: ${e.message}`));
    void tick();
    this.sweeper = setInterval(tick, every);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /**
   * The timers above live in this process: a restart or a second server loses them. This sweep,
   * from the database, finishes whatever is overdue:
   * - a cancel window that has passed (the report is sent on);
   * - an offer nobody answered in time (it goes to the next officer);
   * - a report waiting to be routed whose routing never ran (the server stopped in between).
   * Every step is guarded in the database, so two servers sweeping at once never double-apply.
   */
  async sweepOverdue(graceMs = 2000) {
    const done = { windows: 0, offers: 0, routed: 0 };
    const windows = await this.db.query(
      `select id from incidents where state = 'pending_cancel' and created_at < now() - make_interval(secs => $1) order by created_at limit 50`,
      [(this.config.cancelWindowMs + graceMs) / 1000],
    );
    for (const r of windows.rows) {
      clearTimeout(this.timers.get(`window:${r.id}`));
      this.timers.delete(`window:${r.id}`);
      await this.afterCancelWindow(r.id).then(() => done.windows++, (e) => this.log.warn(`window ${r.id}: ${e.message}`));
    }
    const offers = await this.db.query(
      `select incident_id, officer_id from incident_units where state = 'offered' and offer_expires_at < now() - make_interval(secs => $1) order by offer_expires_at limit 50`,
      [graceMs / 1000],
    );
    for (const r of offers.rows) {
      clearTimeout(this.timers.get(`offer:${r.incident_id}:${r.officer_id}`));
      this.timers.delete(`offer:${r.incident_id}:${r.officer_id}`);
      await this.offerTimeout(r.incident_id, r.officer_id, []).then(() => done.offers++, (e) => this.log.warn(`offer ${r.incident_id}: ${e.message}`));
    }
    // Waiting to be routed, nothing offered, and the last thing that happened was the step before
    // routing (not "nobody free" or "no station", which already told the station to act).
    const stranded = await this.db.query(
      `select i.id from incidents i
         cross join lateral (select e.kind, e.at from incident_events e where e.incident_id = i.id order by e.id desc limit 1) last
        where i.state in ('received', 'escalated', 'reassigning', 'transferred')
          and not exists (select 1 from incident_units u where u.incident_id = i.id and u.state = 'offered')
          and last.kind in ('window_elapsed', 'offer_timeout', 'declined', 'officer_drop', 'cant_go', 'transfer')
          and last.at < now() - make_interval(secs => $1)
        order by i.created_at limit 50`,
      [Math.max(10, graceMs / 1000)],
    );
    for (const r of stranded.rows) await this.route(r.id).then(() => done.routed++, (e) => this.log.warn(`route ${r.id}: ${e.message}`));
    if (done.windows || done.offers || done.routed) this.log.log(`sweep finished overdue work: ${JSON.stringify(done)}`);
    return done;
  }

  // ---------------------------------------------------------------- create

  async create(p: Principal, input: CreateIncidentInput) {
    // Idempotent: a device retrying its offline queue gets the same incident.
    const existing = await this.db.query(`select incident_id from incident_reports where client_ref = $1`, [input.clientRef]);
    if (existing.rows[0]) return { id: existing.rows[0].incident_id as string, duplicate: true };

    let building: Building | null = null;
    let addressWarning: string | undefined;
    try {
      building = input.postcode ? await this.postcode.lookup(input.postcode) : input.lat != null ? await this.postcode.nearest(input.lat, input.lng!, 50) : null;
      if (input.postcode && !building) {
        throw new AppError(422, 'postcode_not_found', 'We could not find that building. Check the postcode or pick it from the list.');
      }
    } catch (e) {
      if (!(e instanceof PostcodeUnavailable)) throw e;
      // Never block a report on the address service (States doc).
      addressWarning = 'The address service is not responding. Your report was sent with your location.';
    }
    const lat = building?.lat ?? input.lat;
    const lng = building?.lng ?? input.lng;
    if (lat == null || lng == null) throw new AppError(422, 'location_required', 'Turn on location so help can find you, or pick your building on the map.');

    const id = await this.db.tx(async (c) => {
      const locationId = building ? await this.upsertLocation(c, building) : null;
      const inc = await c.query(
        `insert into incidents (reporter_id, type, location_id, geom, discreet, source)
         values ($1, $2, $3, st_setsrid(st_makepoint($5, $4), 4326)::geography, $6, 'app') returning id`,
        [p.userId, input.type, locationId, lat, lng, input.discreet ?? false],
      );
      const incidentId: string = inc.rows[0].id;
      await c.query(
        `insert into incident_reports (incident_id, reporter_id, source, role, type_chosen, client_ref) values ($1, $2, 'app', 'first', $3, $4)`,
        [incidentId, p.userId, input.type, input.clientRef],
      );
      await this.logEvent(c, incidentId, p.userId, 'reporter', 'confirm', null, 'pending_cancel', { label: 'Sending' }, false);
      return incidentId;
    });

    this.schedule(`window:${id}`, this.config.cancelWindowMs, () => this.afterCancelWindow(id));
    this.publish(id, 'created');
    return { id, duplicate: false, addressWarning };
  }

  private async upsertLocation(c: Queryable, b: Building): Promise<string> {
    const r = await c.query(
      `insert into locations (postcode, building_name, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
       values ($1, $2, $3, $4, $5, $6, $7, $8, st_setsrid(st_makepoint($10, $9), 4326)::geography)
       on conflict (postcode) do update set fetched_at = now() returning id`,
      [b.postcode, b.name ?? null, b.address, b.stateId, b.lgaId, b.districtId, b.areaId, b.areaLabel, b.lat, b.lng],
    );
    return r.rows[0].id;
  }

  // ---------------------------------------------------------------- transitions

  /**
   * The single path for state changes: lock, check the machine, write state +
   * append-only event in one transaction, then publish.
   */
  private async transition(
    incidentId: string,
    event: IncidentEvent,
    actor: IncidentActor,
    actorId: string | null,
    extra: (c: Queryable, row: IncidentRow) => Promise<Record<string, unknown> | void> = async () => {},
    sets: Record<string, unknown> = {},
  ): Promise<IncidentState> {
    const to = await this.db.tx(async (c) => {
      const row = await this.repo.row(incidentId, c, true);
      if (!row) throw new AppError(404, 'not_found', 'This report could not be found.');
      const r = applyIncidentEvent(row.state, event, actor);
      if (!r.ok) {
        const status = r.code === 'actor_not_allowed' ? 403 : 409;
        throw new AppError(status, r.code, humanTransitionError(event, row.state, r.message));
      }
      const payload = (await extra(c, row)) ?? {};
      const cols = Object.keys(sets);
      await c.query(
        `update incidents set state = $2, version = version + 1${cols.map((k, n) => `, ${k} = $${n + 3}`).join('')}
          ${r.to === 'received' ? ', received_at = now()' : ''}
          ${['resolved', 'unfounded', 'cancelled', 'merged'].includes(r.to) ? ', closed_at = now()' : ''}
          where id = $1`,
        [incidentId, r.to, ...cols.map((k) => sets[k])],
      );
      const label = PUBLIC_LABELS[event];
      await this.logEvent(c, incidentId, actorId, actor, event, r.from, r.to, { ...payload, label: label ?? event }, Boolean(label));
      await this.noticesFor(c, incidentId, event, row);
      return r.to;
    });
    this.publish(incidentId, event);
    return to;
  }

  private async logEvent(
    c: Queryable,
    incidentId: string,
    actorId: string | null,
    actor: IncidentActor,
    kind: string,
    from: string | null,
    to: string | null,
    payload: Record<string, unknown>,
    isPublic: boolean,
  ) {
    await c.query(
      `insert into incident_events (incident_id, actor_id, actor_kind, kind, from_state, to_state, payload, public) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [incidentId, actorId, actor, kind, from, to, payload, isPublic],
    );
  }

  private publish(incidentId: string, kind: string) {
    this.bus.publishIncident({ incidentId, kind, at: new Date().toISOString() });
  }

  private schedule(key: string, ms: number, fn: () => Promise<unknown>) {
    clearTimeout(this.timers.get(key));
    // Fast path only: if this process stops, sweepOverdue() finishes the job from the database.
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn().catch((e) => this.log.error(`${key}: ${e.message}`));
      }, ms),
    );
  }

  // ---------------------------------------------------------------- system steps

  private async afterCancelWindow(id: string) {
    const row = await this.repo.row(id);
    if (!row || row.state !== 'pending_cancel') return;
    await this.transition(id, 'window_elapsed', 'system', null);
    if (await this.tryMerge(id)) return;
    await this.notifyContacts(id);
    await this.route(id);
  }

  /** TRD duplicates: same type family, same postcode → auto-merge; send first, merge after. */
  private async tryMerge(id: string): Promise<boolean> {
    const match = await this.db.query(
      `select t.id from incidents n
         join incident_types nt on nt.code = n.type
         join incidents t on t.id <> n.id
         join incident_types tt on tt.code = t.type and tt.family = nt.family
        where n.id = $1
          and t.state in ('received', 'offered', 'escalated', 'accepted', 'en_route', 'on_scene')
          and t.created_at > now() - make_interval(mins => $2)
          and n.location_id is not null and t.location_id = n.location_id
        order by t.created_at limit 1`,
      [id, MERGE_WINDOW_MIN],
    );
    const target: string | undefined = match.rows[0]?.id;
    if (!target) {
      const near = await this.db.query(
        `select t.id, st_distance(t.geom, n.geom)::int as d from incidents n, incidents t
          where n.id = $1 and t.id <> n.id and t.state in ('received', 'offered', 'escalated', 'accepted', 'en_route', 'on_scene')
            and t.created_at > now() - make_interval(mins => $3) and st_dwithin(t.geom, n.geom, $2)
          order by d limit 3`,
        [id, MERGE_RADIUS_M, MERGE_WINDOW_MIN],
      );
      for (const r of near.rows) {
        await this.db.query(
          `insert into merge_suggestions (incident_id, candidate_id, distance_m, gap_seconds)
           select $1, $2, $3, extract(epoch from (a.created_at - b.created_at))::int from incidents a, incidents b where a.id = $1 and b.id = $2`,
          [id, r.id, r.d],
        );
      }
      return false;
    }
    await this.transition(id, 'merge_into', 'system', null, async (c, row) => {
      await c.query(
        `insert into incident_reports (incident_id, reporter_id, source, role, type_chosen) values ($1, $2, 'app', 'joined', $3)`,
        [target, row.reporter_id, row.type],
      );
      await c.query(`update incidents set report_count = report_count + 1 where id = $1`, [target]);
      await this.logEvent(c, target, null, 'system', 'report_joined', null, null, { label: PUBLIC_LABELS.report_joined }, true);
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'joined_report', 'reports', 'in_app', $2, $3, $4)`,
        [row.reporter_id, row.discreet ? 'Update' : 'Already being handled', row.discreet ? 'Your request is in progress.' : 'Others reported this too. One response is on its way for everyone.', `/reports/${target}`],
      );
      return { into: target };
    }, { merged_into: target, merge_reason: 'same_building' });
    this.publish(target, 'report_joined');
    return true;
  }

  /** Picks a station and the nearest on-duty, verified, free officer. */
  async route(id: string, exclude: string[] = []): Promise<void> {
    const row = await this.repo.row(id);
    if (!row || !['received', 'escalated', 'reassigning', 'transferred'].includes(row.state)) return;
    // Anyone who already declined it or let it expire is skipped, whatever path brought it back here.
    const passed = await this.db.query(`select distinct officer_id::text as id from incident_units where incident_id = $1 and state in ('declined', 'expired')`, [id]);
    exclude = [...new Set([...exclude, ...passed.rows.map((r) => r.id as string)])];

    // Jurisdiction first (Routing doc): a rule for this area, then a station that covers it, then the nearest.
    const station = row.station_id ? { id: row.station_id, in_area: true } : (await this.rankStations(id, row.type, []))[0];
    if (station && !row.station_id && !station.in_area) {
      await this.db.query(
        `insert into incident_events (incident_id, actor_kind, kind, payload) values ($1, 'system', 'outside_area', $2)`,
        [id, JSON.stringify({ stationId: station.id, label: 'No station covers this area; sent to the nearest' })],
      );
    }

    if (!station) {
      await this.db.query(
        `insert into incident_events (incident_id, actor_kind, kind, payload) values ($1, 'system', 'no_station', '{}')`,
        [id],
      );
      this.publish(id, 'no_station');
      return;
    }

    const officer = (
      await this.db.query(
        `select o.user_id, st_distance(o.last_location, st_setsrid(st_makepoint($3, $2), 4326)::geography) as d
           from officers o
          where o.station_id = $1 and o.on_duty and o.badge_status = 'verified'
            and not (o.user_id = any($4::uuid[]))
            and not exists (select 1 from incident_units u where u.officer_id = o.user_id and u.state in ('accepted', 'en_route', 'on_scene'))
          order by d nulls last limit 1`,
        [station.id, row.lat, row.lng, exclude],
      )
    ).rows[0];

    if (!officer) {
      await this.db.query(`update incidents set station_id = $2, agency_id = coalesce(agency_id, (select agency_id from stations where id = $2)) where id = $1`, [id, station.id]);
      // Roster doc: if nobody at this station can take it, the report overflows to the next station.
      const next = await this.nextStation(id, row.type, station.id);
      if (next) {
        await this.db.tx(async (c) => {
          await c.query(`update incidents set station_id = $2, agency_id = (select agency_id from stations where id = $2) where id = $1`, [id, next.id]);
          await this.logEvent(c, id, null, 'system', 'overflow', null, null, { from: station.id, to: next.id, label: 'Passed to the next station' }, true);
          await this.notifyStationHeads(c, station.id, 'no_one_on_duty', 'No one is free', `No one is free at your station. A ${row.type} report went to ${next.name}.`, id);
        });
        this.publish(id, 'overflow');
        return this.route(id, exclude);
      }
      await this.db.tx(async (c) => {
        // Every station is out: hand it back to the station that covers the area (the first one
        // tried) so it shows in that queue, and alert the heads of every station tried.
        const tried = await c.query(
          `select payload->>'from' as s, min(id) as first from incident_events where incident_id = $1 and kind = 'overflow' group by 1 order by first`,
          [id],
        );
        const home = tried.rows[0]?.s ?? station.id;
        if (home !== station.id) {
          await c.query(`update incidents set station_id = $2, agency_id = (select agency_id from stations where id = $2) where id = $1`, [id, home]);
        }
        await this.logEvent(c, id, null, 'system', 'no_responder', null, null, { stationId: home }, false);
        const pc = (await c.query(`select l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [id])).rows[0]?.postcode ?? 'GPS';
        for (const st of new Set([home, station.id, ...tried.rows.map((r) => r.s as string)])) {
          await this.notifyStationHeads(c, st, 'nobody_accepted', 'Nobody accepted', `A ${row.type} report at ${pc} has no responder. Assign a unit or transfer it.`, id);
        }
      });
      this.publish(id, 'no_responder');
      return;
    }

    const windowS = (await this.db.query(`select accept_window_seconds from stations where id = $1`, [station.id])).rows[0].accept_window_seconds;
    const event: IncidentEvent = row.state === 'escalated' ? 'reoffer' : 'route';
    await this.transition(
      id,
      event,
      'system',
      null,
      async (c) => {
        await c.query(
          `insert into incident_units (incident_id, station_id, officer_id, role, offer_expires_at) values ($1, $2, $3, 'primary', now() + make_interval(secs => $4))`,
          [id, station.id, officer.user_id, windowS],
        );
        return { stationId: station.id };
      },
      { station_id: station.id, agency_id: (await this.db.query(`select agency_id from stations where id = $1`, [station.id])).rows[0].agency_id },
    );
    this.schedule(`offer:${id}:${officer.user_id}`, windowS * 1000, () => this.offerTimeout(id, officer.user_id, exclude));
  }

  private async offerTimeout(id: string, officerId: string, exclude: string[]) {
    const expired = await this.db.query(
      `update incident_units set state = 'expired' where incident_id = $1 and officer_id = $2 and state = 'offered' returning id`,
      [id, officerId],
    );
    if (!expired.rowCount) return; // accepted or declined in time
    await this.transition(id, 'offer_timeout', 'system', null);
    await this.route(id, [...exclude, officerId]);
  }

  // ---------------------------------------------------------------- actor checks

  async actorsFor(p: Principal, row: IncidentRow): Promise<IncidentActor[]> {
    const out: IncidentActor[] = [];
    if (row.reporter_id === p.userId) out.push('reporter');
    if (hasRole(p, 'officer') && (await this.repo.unitFor(row.id, p.userId))) out.push('officer');
    if (row.station_id && (hasRole(p, 'head', row.station_id) || hasRole(p, 'dispatcher', row.station_id))) out.push('station');
    if (hasRole(p, 'platform_admin')) out.push('platform_admin');
    return out;
  }

  private async pickActor(p: Principal, id: string, event: IncidentEvent | IncidentSideEvent, preferred: IncidentActor[]): Promise<{ row: IncidentRow; actor: IncidentActor }> {
    const row = await this.repo.row(id);
    if (!row) throw new AppError(404, 'not_found', 'This report could not be found.');
    const actors = await this.actorsFor(p, row);
    const actor = preferred.find((a) => actors.includes(a));
    if (!actor) throw new AppError(403, 'actor_not_allowed', `You cannot ${String(event).replace(/_/g, ' ')} on this report.`);
    return { row, actor };
  }

  // ---------------------------------------------------------------- reporter actions

  async cancel(p: Principal, id: string, reason: string) {
    const { row } = await this.pickActor(p, id, 'reporter_cancel', ['reporter']);
    if (row.state === 'pending_cancel') {
      clearTimeout(this.timers.get(`window:${id}`));
      await this.transition(id, 'cancel_in_window', 'reporter', p.userId, async () => ({ reason }));
      return { state: 'cancelled' as const, free: true, flagged: false };
    }
    const secs = row.received_at ? (Date.now() - row.received_at.getTime()) / 1000 : 0;
    const a = assessReporterCancel(row.state, secs);
    await this.transition(id, 'reporter_cancel', 'reporter', p.userId, async (c) => {
      await c.query(`update incident_units set state = 'released' where incident_id = $1 and state in ('offered', 'accepted', 'en_route')`, [id]);
      return { reason, ...a };
    }, { cancel_flagged: a.flagged });
    return { state: 'cancelled' as const, ...a };
  }

  async sideEvent(p: Principal, id: string, kind: IncidentSideEvent, payload: { text?: string; reason?: string }) {
    const who: Record<string, IncidentActor[]> = {
      add_info: ['reporter'],
      note: ['officer', 'station'],
      reinforce: ['officer', 'station'],
      officer_panic: ['officer'],
      panic_cleared: ['officer', 'station'],
      drone_requested: ['officer'],
      transfer_requested: ['officer'],
    };
    if (!who[kind]) throw new AppError(400, 'unsupported_event', 'That action is not available here.');
    const { row, actor } = await this.pickActor(p, id, kind, who[kind]!);
    if (!sideEventAllowedIn[kind].includes(row.state)) throw new AppError(409, 'invalid_transition', 'That action is not available at this stage.');
    if ((kind === 'note' || kind === 'add_info') && !payload.text?.trim()) throw new AppError(422, 'text_required', 'Write a note before saving.');
    if (kind === 'reinforce' && !payload.reason?.trim()) throw new AppError(422, 'reason_required', 'Say why you need help.');
    if (kind === 'transfer_requested' && !payload.reason?.trim()) throw new AppError(422, 'reason_required', 'Say why it should move.');
    const label = kind === 'officer_panic' ? 'Officer needs help' : kind === 'drone_requested' ? 'Drone requested' : kind === 'transfer_requested' ? 'Transfer requested' : PUBLIC_LABELS[kind] ?? kind;
    await this.logEvent(this.db.pool, id, p.userId, actor, kind, null, null, { ...payload, label }, kind === 'reinforce');
    if (kind === 'officer_panic') {
      await this.audit.write({ actorId: p.userId, actorRole: 'officer', action: 'incident.officer_panic', entity: 'incident', entityId: id });
      // B1: station head, dispatchers and every other on-duty officer at the station are told at once.
      await this.db.tx(async (c) => {
        const who = (await c.query(`select u.display_name, l.postcode from users u, incidents i left join locations l on l.id = i.location_id where u.id = $1 and i.id = $2`, [p.userId, id])).rows[0];
        const body = `${who?.display_name ?? 'An officer'} needs help at ${who?.postcode ?? 'their location'}.`;
        if (row.station_id) await this.notifyStationHeads(c, row.station_id, 'officer_panic', 'Officer needs help', body, id);
        await c.query(
          `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
           select o.user_id, 'officer_panic', 'dispatch', 'in_app', 'Officer needs help', $3, $4
             from officers o where o.station_id = $1 and o.on_duty and o.user_id <> $2`,
          [row.station_id, p.userId, body, `/incidents/${id}`],
        );
      });
    }
    if ((kind === 'reinforce' || kind === 'drone_requested' || kind === 'transfer_requested') && row.station_id) {
      // The station head assigns the second unit or the drone, or moves the report (board "Officer incident log").
      await this.db.tx(async (c) => {
        const who = (await c.query(`select u.display_name, l.postcode, i.type from users u, incidents i left join locations l on l.id = i.location_id where u.id = $1 and i.id = $2`, [p.userId, id])).rows[0];
        const what = { reinforce: 'asks for reinforcement', drone_requested: 'asks for a drone', transfer_requested: 'asks to transfer' }[kind];
        const title = { reinforce: 'Reinforcement requested', drone_requested: 'Drone requested', transfer_requested: 'Transfer requested' }[kind];
        await this.notifyStationHeads(
          c,
          row.station_id!,
          kind === 'reinforce' ? 'reinforcement_requested' : kind,
          title,
          `${who?.display_name ?? 'An officer'} ${what} at ${cap(who?.type ?? 'the incident')}, ${who?.postcode ?? 'GPS location'}${payload.reason ? `: ${payload.reason}` : '.'}`,
          id,
        );
      });
    }
    this.publish(id, kind);
    return { ok: true };
  }

  /**
   * What happened to an offer, for the officer who got it (boards "Officer dispatch offer" and
   * "Officer offer expired"): still open, expired, declined, or taken by another unit.
   */
  async offerStatus(p: Principal, id: string) {
    const u = (
      await this.db.query(
        `select u.state, u.accepted_at, u.decline_reason, greatest(0, extract(epoch from (u.offer_expires_at - now())))::int as seconds_left, u.offered_at,
                (select accept_window_seconds from stations where id = u.station_id) as window_s
           from incident_units u where u.incident_id = $1 and u.officer_id = $2 order by u.offered_at desc limit 1`,
        [id, p.userId],
      )
    ).rows[0];
    if (!u) throw new AppError(404, 'not_found', 'This offer could not be found.');
    const i = (
      await this.db.query(
        `select i.type, i.state, l.postcode, l.address_text, l.area_label, st_distance(o.last_location, i.geom) as distance_m
           from incidents i left join locations l on l.id = i.location_id left join officers o on o.user_id = $2 where i.id = $1`,
        [id, p.userId],
      )
    ).rows[0];
    const taker = (
      await this.db.query(
        `select ou.display_name, o.badge_no, s.name as station from incident_units x
           join users ou on ou.id = x.officer_id left join officers o on o.user_id = x.officer_id join stations s on s.id = x.station_id
          where x.incident_id = $1 and x.officer_id <> $2 and x.accepted_at is not null order by x.accepted_at desc limit 1`,
        [id, p.userId],
      )
    ).rows[0];
    const open = u.state === 'offered' && u.seconds_left > 0;
    // Missed (timed out) and declined offers count in the acceptance rate. An offer pulled before it
    // timed out, because another unit took the report or it was cancelled or moved, does not.
    const state = open
      ? 'offered'
      : u.accepted_at
        ? 'accepted'
        : u.state === 'declined'
          ? 'declined'
          : u.state === 'expired' || u.state === 'offered'
            ? 'expired'
            : taker
              ? 'taken'
              : 'withdrawn';
    return {
      state,
      secondsLeft: open ? u.seconds_left : 0,
      windowSeconds: u.window_s,
      report: { type: i.type, label: `${cap(i.type)}, ${i.postcode ?? 'GPS location'}`, postcode: i.postcode, address: i.address_text, area: i.area_label },
      distanceM: i.distance_m == null ? null : Math.round(i.distance_m),
      takenBy: taker ? { name: taker.display_name, badgeNo: taker.badge_no, station: taker.station } : null,
      counted: state === 'declined' || state === 'expired',
    };
  }

  // ---------------------------------------------------------------- responder actions

  async act(p: Principal, id: string, event: IncidentEvent, body: { reason?: string; outcomeCode?: string; targetStationId?: string; etaMinutes?: number }) {
    const preferred: Record<string, IncidentActor[]> = {
      accept: ['officer'],
      start_route: ['officer'],
      arrive: ['officer'],
      officer_drop: ['officer', 'station'],
      transfer: ['station'],
      begin_close: ['officer', 'station'],
      close_valid: ['officer', 'station'],
      close_unfounded: ['officer', 'station'],
    };
    if (!preferred[event]) throw new AppError(400, 'unsupported_event', 'That action is not available here.');
    const { actor } = await this.pickActor(p, id, event, preferred[event]!);

    switch (event) {
      case 'accept':
        return this.transition(id, 'accept', actor, p.userId, async (c) => {
          const u = await c.query(
            `update incident_units set state = 'accepted', accepted_at = now()
              where incident_id = $1 and officer_id = $2 and state = 'offered' and offer_expires_at > now() returning id`,
            [id, p.userId],
          );
          if (!u.rowCount) throw new AppError(409, 'offer_expired', 'This offer expired. Nothing was recorded against you.');
          await c.query(`update incident_units set state = 'taken' where incident_id = $1 and state = 'offered'`, [id]);
          clearTimeout(this.timers.get(`offer:${id}:${p.userId}`));
        }, { eta_minutes: body.etaMinutes ?? null });
      case 'start_route':
        return this.transition(id, 'start_route', actor, p.userId, async (c) => {
          await c.query(`update incident_units set state = 'en_route' where incident_id = $1 and officer_id = $2 and state = 'accepted'`, [id, p.userId]);
        }, body.etaMinutes != null ? { eta_minutes: body.etaMinutes } : {});
      case 'arrive':
        return this.transition(id, 'arrive', actor, p.userId, async (c) => {
          await c.query(`update incident_units set state = 'on_scene', arrived_at = now() where incident_id = $1 and officer_id = $2`, [id, p.userId]);
        }, { eta_minutes: null });
      case 'officer_drop': {
        if (!body.reason) throw new AppError(422, 'reason_required', 'A reason is required.');
        const to = await this.transition(id, 'officer_drop', actor, p.userId, async (c) => {
          await c.query(`update incident_units set state = 'dropped' where incident_id = $1 and state in ('accepted', 'en_route')`, [id]);
          return { reason: body.reason };
        });
        await this.route(id, [p.userId]);
        return to;
      }
      case 'transfer': {
        if (!body.targetStationId || !body.reason) throw new AppError(422, 'reason_required', 'Choose a station and say why.');
        const to = await this.transition(id, 'transfer', actor, p.userId, async (c) => {
          await c.query(`update incident_units set state = 'released' where incident_id = $1 and state in ('offered', 'accepted', 'en_route', 'on_scene')`, [id]);
          return { reason: body.reason, to: body.targetStationId };
        }, { station_id: body.targetStationId });
        await this.route(id);
        return to;
      }
      case 'begin_close':
        return this.transition(id, 'begin_close', actor, p.userId);
      case 'close_valid':
      case 'close_unfounded': {
        if (!body.outcomeCode) throw new AppError(422, 'outcome_required', 'Choose an outcome before closing.');
        if (event === 'close_unfounded' && !body.reason) throw new AppError(422, 'evidence_required', 'Add what you found before marking this unfounded.');
        const to = await this.transition(id, event, actor, p.userId, async (c) => {
          await c.query(`update incident_units set state = 'released' where incident_id = $1 and state in ('offered', 'accepted', 'en_route', 'on_scene')`, [id]);
          if (event === 'close_unfounded') {
            await c.query(
              `insert into false_alarm_cases (incident_id, verdict, evidence, decided_by) values ($1, $2, $3, $4)`,
              [id, body.outcomeCode === 'malicious' ? 'malicious' : 'unfounded', { note: body.reason }, p.userId],
            );
          }
          await c.query(`update tracking_links set expires_at = now() + make_interval(hours => $2) where incident_id = $1`, [id, incidentTimers.contactLinkTtlHoursAfterClose]);
          return { outcomeCode: body.outcomeCode };
        }, { outcome_code: body.outcomeCode });
        // B8: a warning first, then a fine, for the person who sent it (never joiners).
        if (event === 'close_unfounded') await this.fines.onUnfounded(id);
        return to;
      }
    }
    throw new AppError(400, 'unsupported_event', 'That action is not available here.');
  }

  // ---------------------------------------------------------------- duplicates (board "Station incident detail")

  private stationOf(p: Principal, row: IncidentRow) {
    if (!row.station_id || !(hasRole(p, 'head', row.station_id) || hasRole(p, 'dispatcher', row.station_id))) throw new AppError(404, 'not_found', 'This report could not be found.');
  }

  /**
   * Possible duplicates: other open reports within 500 m in the last hour that were not merged on
   * their own (a different building, or a related type), and not already kept separate.
   */
  async duplicates(p: Principal, id: string) {
    const row = await this.repo.row(id);
    if (!row) throw new AppError(404, 'not_found', 'This report could not be found.');
    this.stationOf(p, row);
    const r = await this.db.query(
      `select t.id, t.type, t.created_at, t.report_count, t.location_id = n.location_id as same_building, tt.family = nt.family as same_family, t.type = n.type as same_type,
              st_distance(t.geom, n.geom)::int as d, l.postcode, coalesce(l.address_text, '') as address
         from incidents n join incident_types nt on nt.code = n.type, incidents t join incident_types tt on tt.code = t.type left join locations l on l.id = t.location_id
        where n.id = $1 and t.id <> n.id and t.state in ('received', 'offered', 'escalated', 'accepted', 'en_route', 'on_scene', 'closing')
          and abs(extract(epoch from (t.created_at - n.created_at))) < 3600 and st_dwithin(t.geom, n.geom, 500)
          and not exists (select 1 from incident_links k where k.a_id = least(n.id, t.id) and k.b_id = greatest(n.id, t.id))
        order by st_distance(t.geom, n.geom) limit 5`,
      [id],
    );
    return r.rows.map((x) => ({
      id: x.id,
      label: `${cap(x.type)}, ${x.postcode ?? 'GPS location'}`,
      distanceM: x.d,
      reports: x.report_count,
      at: x.created_at,
      why: `${x.same_building ? 'Same building' : 'Different building'}, ${x.same_type ? 'same type' : x.same_family ? 'related type' : 'different type'}${x.address ? `, ${x.address}` : ''}.`,
    }));
  }

  /** Merge another open report into this one: one response for everyone; its reporters are told. */
  async mergeIn(p: Principal, id: string, otherId: string) {
    const [row, other] = await Promise.all([this.repo.row(id), this.repo.row(otherId)]);
    if (!row || !other) throw new AppError(404, 'not_found', 'This report could not be found.');
    this.stationOf(p, row);
    if (id === otherId) throw new AppError(422, 'same', 'Choose another report.');
    if (['resolved', 'unfounded', 'cancelled', 'merged'].includes(row.state)) throw new AppError(409, 'closed', 'This report is closed.');
    await this.transition(otherId, 'merge_into', 'station', p.userId, async (c) => {
      const reports = (await c.query(`select reporter_id, source, type_chosen, answers from incident_reports where incident_id = $1 and reporter_id is not null`, [otherId])).rows;
      for (const r of reports) {
        await c.query(`insert into incident_reports (incident_id, reporter_id, source, role, type_chosen, answers) values ($1, $2, $3, 'joined', $4, $5)`, [id, r.reporter_id, r.source, r.type_chosen, r.answers]);
      }
      await c.query(`update incidents set report_count = report_count + $2 where id = $1`, [id, reports.length || 1]);
      await c.query(`update incident_units set state = 'released' where incident_id = $1 and state in ('offered', 'accepted', 'en_route', 'on_scene')`, [otherId]);
      await c.query(`update merge_suggestions set state = 'merged', decided_by = $3 where (incident_id = $1 and candidate_id = $2) or (incident_id = $2 and candidate_id = $1)`, [id, otherId, p.userId]);
      await this.logEvent(c, id, p.userId, 'station', 'report_joined', null, null, { label: PUBLIC_LABELS.report_joined, staffLabel: 'Report merged by the station', from: otherId }, true);
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
         select distinct r.reporter_id, 'joined_report', 'reports', 'in_app', 'Already being handled', 'Others reported this too. One response is on its way for everyone.', $2
           from incident_reports r where r.incident_id = $1 and r.reporter_id is not null`,
        [otherId, `/reports/${id}`],
      );
      return { into: id };
    }, { merged_into: id, merge_reason: 'dispatcher' });
    clearTimeout(this.timers.get(`window:${otherId}`));
    await this.audit.write({ actorId: p.userId, actorRole: 'head', action: 'incident.merge', entity: 'incident', entityId: id, payload: { from: otherId } });
    this.publish(id, 'report_joined');
    return { message: 'Merged. One response for everyone; their reporters are told.' };
  }

  async keepSeparate(p: Principal, id: string, otherId: string) {
    const row = await this.repo.row(id);
    if (!row) throw new AppError(404, 'not_found', 'This report could not be found.');
    this.stationOf(p, row);
    const [a, b] = id < otherId ? [id, otherId] : [otherId, id];
    await this.db.query(`insert into incident_links (a_id, b_id, reason) values ($1, $2, 'kept_separate') on conflict do nothing`, [a, b]);
    await this.db.query(`update merge_suggestions set state = 'kept_separate', decided_by = $3 where (incident_id = $1 and candidate_id = $2) or (incident_id = $2 and candidate_id = $1)`, [id, otherId, p.userId]);
    return { message: 'Kept separate. It will not be suggested again.' };
  }

  /** Split a report that was merged automatically but is a different emergency: it gets its own response. */
  async split(p: Principal, id: string, reportId: string) {
    const row = await this.repo.row(id);
    if (!row) throw new AppError(404, 'not_found', 'This report could not be found.');
    this.stationOf(p, row);
    const newId = await this.db.tx(async (c) => {
      const r = (await c.query(`select * from incident_reports where id = $1 and incident_id = $2 for update`, [reportId, id])).rows[0];
      if (!r) throw new AppError(404, 'not_found', 'Report not found.');
      if (r.role !== 'joined' || !r.reporter_id) throw new AppError(409, 'not_joined', 'Only a report that joined this one can be split off.');
      const i = (
        await c.query(
          `insert into incidents (reporter_id, type, location_id, geom, state, received_at, station_id, agency_id, discreet, source)
           select $2, $3, i.location_id, i.geom, 'received', now(), null, null, false, 'app' from incidents i where i.id = $1 returning id`,
          [id, r.reporter_id, r.type_chosen],
        )
      ).rows[0];
      await c.query(`update incident_reports set incident_id = $2, role = 'first' where id = $1`, [reportId, i.id]);
      await c.query(`update incidents set report_count = greatest(1, report_count - 1) where id = $1`, [id]);
      await this.logEvent(c, id, p.userId, 'station', 'split', null, null, { label: 'Report split off', newIncident: i.id }, false);
      await this.logEvent(c, i.id, p.userId, 'station', 'split', null, 'received', { label: 'Report received', from: id }, true);
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'report_split', 'reports', 'in_app', 'Handled on its own', 'Your report is a different emergency, so it now has its own response. Finding the nearest team.', $2)`,
        [r.reporter_id, `/reports/${i.id}`],
      );
      return i.id as string;
    });
    await this.audit.write({ actorId: p.userId, actorRole: 'head', action: 'incident.split', entity: 'incident', entityId: id, payload: { newIncident: newId } });
    this.publish(id, 'split');
    await this.route(newId);
    return { id: newId, message: 'Split off. It has its own response now.' };
  }

  /** Next station: the routing rule's fallback first, then another station covering the area, then the nearest not yet tried. */
  private async nextStation(id: string, type: string, current: string): Promise<{ id: string; name: string } | null> {
    const tried = (
      await this.db.query(
        `select station_id::text as s from incident_units where incident_id = $1
          union select payload->>'from' from incident_events where incident_id = $1 and kind = 'overflow'
          union select $2::text`,
        [id, current],
      )
    ).rows.map((r) => r.s as string);
    return (await this.rankStations(id, type, tried, current))[0] ?? null;
  }

  /**
   * Eligible stations for a report, best first: (0) a routing rule for the report's area, district or
   * LGA, or the current station's named fallback; (1) a station whose areas or zone cover the report;
   * (2) everyone else of the right agency type. Rule priority, then distance, break ties.
   */
  private async rankStations(id: string, type: string, tried: string[], current: string | null = null): Promise<Array<{ id: string; name: string; in_area: boolean }>> {
    const r = await this.db.query(
      `with inc as (select geom, location_id from incidents where id = $1),
            -- The report's place: its building, else the nearest known building within 500 m.
            place as (
              select * from (
                select 0 as k, l.lga_id, l.district_id, l.area_id from locations l join inc on l.id = inc.location_id
                union all
                (select 1, l.lga_id, l.district_id, l.area_id from locations l, inc
                  where st_dwithin(l.geom, inc.geom, 500) order by st_distance(l.geom, inc.geom) limit 1)
              ) x order by k limit 1
            ),
            ranked as (
              select s.id, s.name,
                     (select min(rr.priority) from routing_rules rr, place
                       where rr.active and rr.station_id = s.id and rr.incident_type = $2 and rr.area_id in (place.area_id, place.district_id, place.lga_id)) as area_rule,
                     exists (select 1 from routing_rules rr where rr.active and rr.station_id = $4 and rr.incident_type = $2 and rr.next_station_id = s.id) as fallback,
                     (coalesce(st_covers(s.zone, inc.geom), false) or exists (
                        select 1 from station_areas sa, place where sa.station_id = s.id
                           and ((sa.level = 'area' and sa.area_id = place.area_id) or (sa.level = 'district' and sa.area_id = place.district_id) or (sa.level = 'lga' and sa.area_id = place.lga_id)))) as covers,
                     (select min(rr.priority) from routing_rules rr where rr.active and rr.station_id = s.id and rr.incident_type = $2 and rr.area_id is null) as rule,
                     st_distance(coalesce(s.zone::geometry, (select geom::geometry from locations where id = s.location_id))::geography, inc.geom) as d
                from stations s
                join agencies a on a.id = s.agency_id and a.status = any($5::text[])
                join incident_types t on t.code = $2 and a.kind = any(t.default_units)
                cross join inc
               where s.status = 'active' and not (s.id::text = any($3::text[]))
            )
       select id, name, (area_rule is not null or covers) as in_area from ranked
        order by case when area_rule is not null or fallback then 0 when covers then 1 else 2 end,
                 area_rule nulls last, rule nulls last, d nulls last`,
      [id, type, tried, current, dispatchingAgencyStates],
    );
    return r.rows;
  }

  private async notifyStationHeads(c: Queryable, stationId: string, type: string, title: string, body: string, incidentId: string) {
    await c.query(
      `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
       select ur.user_id, $2, 'dispatch', 'in_app', $3, $4, $5 from user_roles ur
        where ur.scope_type = 'station' and ur.scope_id = $1 and ur.role in ('head', 'dispatcher')`,
      [stationId, type, title, body, `/incidents/${incidentId}`],
    );
  }

  /** Notification catalogue (States and Notifications (1)), written in the same transaction as the change. */
  private async noticesFor(c: Queryable, incidentId: string, event: string, row: IncidentRow) {
    const info = (
      await c.query(
        `select i.type, i.eta_minutes, l.postcode,
                (select ou.display_name from incident_units u join users ou on ou.id = u.officer_id
                  where u.incident_id = i.id and u.state in ('accepted', 'en_route', 'on_scene', 'dropped', 'cant_go', 'released') order by u.accepted_at desc nulls last limit 1) as officer,
                (select s.name from stations s where s.id = i.station_id) as station
           from incidents i left join locations l on l.id = i.location_id where i.id = $1`,
        [incidentId],
      )
    ).rows[0];
    const link = `/reports/${incidentId}`;
    const toCitizens = async (type: string, title: string, body: string) => {
      // Discreet mode: neutral words, no names (Design Brief).
      const [t, b] = row.discreet ? ['Update', 'Your request is in progress.'] : [title, body];
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
         select distinct ir.reporter_id, $2, 'reports', 'in_app', $3, $4, $5 from incident_reports ir
          where ir.incident_id = $1 and ir.reporter_id is not null`,
        [incidentId, type, t, b, link],
      );
    };
    switch (event) {
      case 'window_elapsed':
        return toCitizens('report_received', 'Report received', 'We got your report. Finding the nearest team.');
      case 'accept':
        return toCitizens('team_accepted', 'Help accepted', `${info.officer ?? 'An officer'} from ${info.station ?? 'the station'} is on the way.${info.eta_minutes ? ` About ${info.eta_minutes} ${info.eta_minutes === 1 ? 'minute' : 'minutes'}.` : ''}`);
      case 'direct_assign':
        return toCitizens('team_accepted', 'Help accepted', `${info.officer ?? 'An officer'} from ${info.station ?? 'the station'} is on the way.`);
      case 'reassign':
        return toCitizens('officer_changed', 'New officer', `${info.officer ?? 'Another officer'} from ${info.station ?? 'the station'} is coming instead.`);
      case 'cant_go':
      case 'officer_drop':
        return toCitizens('officer_cancelled', 'Changing teams', `${info.officer ?? 'The officer'} cannot come. We are sending another team.`);
      case 'arrive':
        return toCitizens('team_arrived', 'Help has arrived', 'Help has arrived.');
      case 'close_valid':
        return toCitizens('report_closed', 'Report closed', 'Your report is closed. Please rate the response.');
      case 'route':
      case 'reoffer':
      case 'assign': {
        const u = (await c.query(`select officer_id, station_id, extract(epoch from (offer_expires_at - now()))::int as s from incident_units where incident_id = $1 and state = 'offered' order by offered_at desc limit 1`, [incidentId])).rows[0];
        if (!u) return;
        // The station hears about a new report when it first arrives (its dashboard plays the dispatch sound).
        if (event === 'route' && u.station_id) {
          await this.notifyStationHeads(c, u.station_id, 'station_new_report', 'New report', `${cap(info.type)} at ${info.postcode ?? 'GPS location'}. Offered to an officer.`, incidentId);
        }
        await c.query(
          `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'new_offer', 'dispatch', 'in_app', 'New offer', $2, $3)`,
          [u.officer_id, `${cap(info.type)} at ${info.postcode ?? 'GPS location'}. Accept within ${Math.max(0, u.s)} seconds.`, `/offers/${incidentId}`],
        );
        return;
      }
    }
  }

  /** Post-incident rating (SRS TRUST-4). Reporter and joiners each rate once. */
  async rate(p: Principal, id: string, b: { stars: number; tags: string[]; comment?: string }) {
    const row = await this.repo.row(id);
    if (!row) throw new AppError(404, 'not_found', 'This report could not be found.');
    const isReporter = (await this.db.query(`select 1 from incident_reports where incident_id = $1 and reporter_id = $2 limit 1`, [id, p.userId])).rowCount;
    if (!isReporter) throw new AppError(404, 'not_found', 'This report could not be found.');
    if (row.state !== 'resolved') throw new AppError(409, 'not_closed', 'You can rate the response once the report is closed.');
    await this.db.tx(async (c) => {
      const ins = await c.query(
        `insert into ratings (incident_id, reporter_id, stars, tags, comment) values ($1, $2, $3, $4, $5) on conflict do nothing returning stars`,
        [id, p.userId, b.stars, b.tags, b.comment?.trim() || null],
      );
      if (!ins.rowCount) throw new AppError(409, 'already_rated', 'You already rated this response. Thank you.');
      const pc = (await c.query(`select l.postcode, i.type from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [id])).rows[0];
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
         select distinct u.officer_id, 'rating_received', 'team', 'in_app', 'Rating received', $2, $3
           from incident_units u where u.incident_id = $1 and u.accepted_at is not null`,
        [id, `You got ${b.stars} ${b.stars === 1 ? 'star' : 'stars'} for ${cap(pc.type)} at ${pc.postcode ?? 'GPS location'}.`, `/history/${id}`],
      );
    });
    this.publish(id, 'rated');
    // The first rating decides the officers' reward; it never fails the rating itself.
    await this.rewards.payForRating(id, p.userId, b.stars);
    return { ok: true, message: 'Thank you. Your rating helps teams improve.' };
  }

  async decline(p: Principal, id: string, reason: string) {
    if (!['busy', 'too_far', 'off_duty', 'other'].includes(reason)) {
      throw new AppError(422, 'reason_required', 'A reason is required: busy, too far, off duty, other.');
    }
    const u = await this.db.query(
      `update incident_units set state = 'declined', decline_reason = $3 where incident_id = $1 and officer_id = $2 and state = 'offered' returning id`,
      [id, p.userId, reason],
    );
    if (!u.rowCount) throw new AppError(409, 'offer_expired', 'This offer expired. Nothing was recorded against you.');
    clearTimeout(this.timers.get(`offer:${id}:${p.userId}`));
    const label = `Declined: ${DECLINE_LABELS[reason]}`;
    await this.db.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload) values ($1, $2, 'officer', 'declined', $3)`, [id, p.userId, { reason, label }]);
    await this.transition(id, 'offer_timeout', 'system', null);
    await this.route(id, [p.userId]);
    return { ok: true };
  }

  // ---------------------------------------------------------------- station assign and reassign

  /** Head or dispatcher, for the audit log. */
  private staffRole(p: Principal, stationId: string | null) {
    return stationId && hasRole(p, 'head', stationId) ? 'head' : 'dispatcher';
  }

  /** The officer the station chose: at this station, on duty, badge verified and not on another report. */
  private async chosenOfficer(officerId: string, stationId: string | null) {
    const o = (
      await this.db.query(
        `select o.user_id, o.on_duty, o.badge_status, u.display_name as name,
                exists (select 1 from incident_units x where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene')) as busy
           from officers o join users u on u.id = o.user_id where o.user_id = $1 and o.station_id = $2`,
        [officerId, stationId],
      )
    ).rows[0];
    if (!o) throw new AppError(422, 'officer_not_found', 'Choose an officer from your station.');
    if (o.badge_status !== 'verified') throw new AppError(422, 'badge_not_verified', 'This officer cannot take reports until their badge is verified.');
    if (!o.on_duty) throw new AppError(422, 'off_duty', 'This officer is off duty.');
    if (o.busy) throw new AppError(422, 'officer_busy', 'This officer is already on a report.');
    return o as { user_id: string; name: string };
  }

  /**
   * Stalled: nobody has the report and the normal offers are not getting anywhere. It escalated or
   * is waiting to be routed, an officer already declined it or let it run out, or it has waited
   * longer than two accept windows.
   */
  async stalled(row: IncidentRow): Promise<boolean> {
    if (['received', 'escalated', 'reassigning', 'transferred'].includes(row.state)) return true;
    if (row.state !== 'offered') return false;
    const r = (
      await this.db.query(
        `select (select count(*) from incident_units x where x.incident_id = i.id and x.state in ('declined', 'expired', 'cant_go'))::int as passed,
                extract(epoch from now() - coalesce(i.received_at, i.created_at))::int as age, coalesce(s.accept_window_seconds, 60) as w
           from incidents i left join stations s on s.id = i.station_id where i.id = $1`,
        [row.id],
      )
    ).rows[0];
    return r.passed > 0 || r.age >= 2 * r.w;
  }

  /** Pulls offers still running; they do not count against those officers. */
  private async withdrawOffers(c: Queryable, id: string, why: string) {
    const w = await c.query(`update incident_units set state = 'withdrawn', ended_at = now() where incident_id = $1 and state = 'offered' returning officer_id`, [id]);
    for (const r of w.rows) {
      clearTimeout(this.timers.get(`offer:${id}:${r.officer_id}`));
      await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'offer_withdrawn', 'dispatch', 'in_app', 'Offer withdrawn', $2, $3)`, [
        r.officer_id,
        `${why} Nothing was recorded against you.`,
        `/offers/${id}`,
      ]);
    }
  }

  /**
   * The station puts an officer on the report (S-1 Assign unit).
   * - offer: the officer gets the offer and has to accept it in time. It replaces an offer still running.
   * - direct: only once the report has stalled. The officer is on it at once, with the station's
   *   reason, and can answer "can't go".
   */
  async assign(p: Principal, id: string, b: { officerId: string; mode?: 'offer' | 'direct'; reason?: string }) {
    const mode = b.mode ?? 'offer';
    const reason = b.reason?.trim() || null;
    const event = mode === 'direct' ? 'direct_assign' : 'assign';
    const { row } = await this.pickActor(p, id, event, ['station']);
    const o = await this.chosenOfficer(b.officerId, row.station_id);
    if (mode === 'direct') {
      if (!reason) throw new AppError(422, 'reason_required', 'Say why you are sending this officer.');
      if (!(await this.stalled(row))) {
        throw new AppError(409, 'not_stalled', 'Send an officer directly only when nobody has taken the report. Offer it to them instead, or wait for the offer to run out.');
      }
    }
    const pc = (await this.db.query(`select l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [id])).rows[0]?.postcode ?? 'GPS location';
    const what = `${cap(row.type)} at ${pc}`;

    if (mode === 'offer') {
      const windowS = (await this.db.query(`select accept_window_seconds from stations where id = $1`, [row.station_id])).rows[0].accept_window_seconds;
      const to = await this.transition(id, 'assign', 'station', p.userId, async (c) => {
        await this.withdrawOffers(c, id, `The station offered ${what} to another officer.`);
        await c.query(
          `insert into incident_units (incident_id, station_id, officer_id, role, offer_expires_at, assign_mode, assigned_by, assign_reason)
           values ($1, $2, $3, 'primary', now() + make_interval(secs => $4), 'offer', $5, $6)`,
          [id, row.station_id, o.user_id, windowS, p.userId, reason],
        );
        return { officerId: o.user_id, reason, staffLabel: `Offered to ${o.name} by the station` };
      });
      this.schedule(`offer:${id}:${o.user_id}`, windowS * 1000, () => this.offerTimeout(id, o.user_id, []));
      await this.audit.write({ actorId: p.userId, actorRole: this.staffRole(p, row.station_id), action: 'incident.assign_offer', entity: 'incident', entityId: id, payload: { officerId: o.user_id, reason } });
      return { state: to, message: `Offered to ${o.name}. They have to accept in time.` };
    }

    const to = await this.transition(
      id,
      'direct_assign',
      'station',
      p.userId,
      async (c) => {
        await this.withdrawOffers(c, id, `The station sent another officer to ${what}.`);
        await c.query(
          `insert into incident_units (incident_id, station_id, officer_id, role, state, accepted_at, assign_mode, assigned_by, assign_reason)
           values ($1, $2, $3, 'primary', 'accepted', now(), 'direct', $4, $5)`,
          [id, row.station_id, o.user_id, p.userId, reason],
        );
        await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'direct_assignment', 'dispatch', 'in_app', 'Assigned by your station', $2, $3)`, [
          o.user_id,
          `Go to ${what} now. ${reason} If you cannot go, say so in the app.`,
          `/incidents/${id}`,
        ]);
        return { officerId: o.user_id, reason, staffLabel: `Sent directly: ${o.name}. ${reason}` };
      },
      { eta_minutes: null },
    );
    await this.audit.write({ actorId: p.userId, actorRole: this.staffRole(p, row.station_id), action: 'incident.assign_direct', entity: 'incident', entityId: id, payload: { officerId: o.user_id, reason } });
    return { state: to, message: `${o.name} is on the report now.` };
  }

  /** The station moves the report from the officer on it to another officer it chooses. */
  async reassignTo(p: Principal, id: string, b: { officerId: string; reason: string }) {
    const { row } = await this.pickActor(p, id, 'reassign', ['station']);
    const reason = b.reason.trim();
    if (!reason) throw new AppError(422, 'reason_required', 'Say why you are reassigning.');
    const o = await this.chosenOfficer(b.officerId, row.station_id);
    const pc = (await this.db.query(`select l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [id])).rows[0]?.postcode ?? 'GPS location';
    const what = `${cap(row.type)} at ${pc}`;
    const to = await this.transition(
      id,
      'reassign',
      'station',
      p.userId,
      async (c) => {
        const off = await c.query(
          `update incident_units x set state = 'released', ended_at = now() from users u
            where x.incident_id = $1 and x.role = 'primary' and x.state in ('accepted', 'en_route') and u.id = x.officer_id returning x.officer_id, u.display_name`,
          [id],
        );
        for (const r of off.rows) {
          await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'reassigned_off', 'dispatch', 'in_app', 'Taken off a report', $2, $3)`, [
            r.officer_id,
            `Your station moved ${what} to ${o.name}: ${reason}`,
            `/incidents/${id}`,
          ]);
        }
        await c.query(
          `insert into incident_units (incident_id, station_id, officer_id, role, state, accepted_at, assign_mode, assigned_by, assign_reason)
           values ($1, $2, $3, 'primary', 'accepted', now(), 'reassign', $4, $5)`,
          [id, row.station_id, o.user_id, p.userId, reason],
        );
        await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'direct_assignment', 'dispatch', 'in_app', 'Assigned by your station', $2, $3)`, [
          o.user_id,
          `Go to ${what} now. It was moved to you: ${reason} If you cannot go, say so in the app.`,
          `/incidents/${id}`,
        ]);
        const from = off.rows.map((r) => r.display_name).join(', ') || 'the officer';
        return { officerId: o.user_id, from: off.rows.map((r) => r.officer_id), reason, staffLabel: `Reassigned from ${from} to ${o.name}. ${reason}` };
      },
      { eta_minutes: null },
    );
    await this.audit.write({ actorId: p.userId, actorRole: this.staffRole(p, row.station_id), action: 'incident.reassign', entity: 'incident', entityId: id, payload: { officerId: o.user_id, reason } });
    return { state: to, message: `Moved to ${o.name}. The reporter is told a new officer is coming.` };
  }

  /**
   * "Can't go": an officer the station sent (directly, by reassigning, or as the second unit) says
   * they cannot. It is not held against them. The station is told; a first unit's report goes to
   * the next free officer, a second unit is simply stood down.
   */
  async cantGo(p: Principal, id: string, b: { reason: string; note?: string }) {
    const label = CANT_GO_LABELS[b.reason];
    if (!label) throw new AppError(422, 'reason_required', 'Choose why you cannot go.');
    const note = b.note?.trim() || null;
    if (b.reason === 'other' && !note) throw new AppError(422, 'note_required', 'Say why you cannot go.');
    const { row } = await this.pickActor(p, id, 'cant_go', ['officer']);
    const u = (await this.db.query(`select id, role, state, assign_mode from incident_units where incident_id = $1 and officer_id = $2 and state in ('accepted', 'en_route') order by offered_at desc limit 1`, [id, p.userId])).rows[0];
    if (!u) throw new AppError(409, 'not_on_way', 'You can say you cannot go only before you arrive.');
    if (u.role !== 'reinforcement' && !['direct', 'reassign'].includes(u.assign_mode)) {
      throw new AppError(409, 'self_accepted', 'You accepted this report yourself. Use Hand over to pass it on.');
    }
    const why = note ? `${label}: ${note}` : label;
    const name = (await this.db.query(`select display_name from users where id = $1`, [p.userId])).rows[0]?.display_name ?? 'An officer';
    const pc = (await this.db.query(`select l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [id])).rows[0]?.postcode ?? 'GPS location';
    const otherFirst = (await this.db.query(`select 1 from incident_units where incident_id = $1 and role = 'primary' and state in ('accepted', 'en_route', 'on_scene') and id <> $2`, [id, u.id])).rowCount;
    const markUnit = (c: Queryable) => c.query(`update incident_units set state = 'cant_go', cant_go_reason = $2, ended_at = now() where id = $1`, [u.id, why]);
    const tellStation = (c: Queryable, after: string) =>
      row.station_id ? this.notifyStationHeads(c, row.station_id, 'cant_go', "Officer can't go", `${name} can't go to ${cap(row.type)} at ${pc}: ${why}. ${after}`, id) : Promise.resolve();

    if (u.role === 'reinforcement' || otherFirst) {
      await this.db.tx(async (c) => {
        await markUnit(c);
        await this.logEvent(c, id, p.userId, 'officer', 'cant_go', null, null, { label: `${name} can't go: ${why}`, reason: b.reason, note }, false);
        await tellStation(c, 'Send someone else if you still need a second unit.');
      });
      this.publish(id, 'cant_go');
    } else {
      await this.transition(id, 'cant_go', 'officer', p.userId, async (c) => {
        await markUnit(c);
        await tellStation(c, 'It is being offered to the next free officer.');
        return { reason: b.reason, note, staffLabel: `${name} can't go: ${why}` };
      }, { eta_minutes: null });
      await this.route(id, [p.userId]);
    }
    await this.audit.write({ actorId: p.userId, actorRole: 'officer', action: 'incident.cant_go', entity: 'incident', entityId: id, payload: { reason: b.reason, note } });
    return { ok: true, message: 'Your station has been told. This is not held against you.' };
  }

  /** What the officer sees about how they were put on the report. */
  async assignmentFor(id: string, officerId: string) {
    const u = (
      await this.db.query(
        `select x.role, x.state, x.assign_mode, x.assign_reason, a.display_name as by
           from incident_units x left join users a on a.id = x.assigned_by
          where x.incident_id = $1 and x.officer_id = $2 order by x.offered_at desc limit 1`,
        [id, officerId],
      )
    ).rows[0];
    if (!u) return null;
    const sent = u.role === 'reinforcement' || ['direct', 'reassign'].includes(u.assign_mode);
    return {
      mode: u.role === 'reinforcement' ? 'reinforcement' : (u.assign_mode ?? 'self'),
      by: u.by ?? null,
      reason: u.assign_reason ?? null,
      unitState: u.state,
      canSayCantGo: sent && ['accepted', 'en_route'].includes(u.state),
    };
  }

  // ---------------------------------------------------------------- emergency contacts (B1, decided: area only)

  private async notifyContacts(id: string) {
    const row = await this.repo.row(id);
    if (!row || row.discreet) return;
    const contacts = await this.db.query(
      `select ec.id, ec.phone, ec.share_location, u.display_name
         from emergency_contacts ec join users u on u.id = ec.user_id
        where ec.user_id = $1 and ($2 <> 'violence' or ec.include_violence_reports)`,
      [row.reporter_id, row.type],
    );
    for (const ct of contacts.rows) {
      const token = randomBytes(18).toString('base64url');
      await this.db.query(
        `insert into tracking_links (token_hash, incident_id, contact_id, share_location) values ($1, $2, $3, $4)`,
        [sha256(token), id, ct.id, ct.share_location],
      );
      const first = String(ct.display_name).split(' ')[0];
      await this.sms
        .send({ to: ct.phone, urgent: true, body: `${first} asked for help. Follow: ${this.config.publicBaseUrl}/t/${token}` })
        .catch((e) => this.log.warn(`contact sms failed: ${e.message}`));
    }
  }

  async trackingLink(token: string) {
    const r = await this.db.query(
      `select incident_id, share_location from tracking_links where token_hash = $1 and (expires_at is null or expires_at > now())`,
      [sha256(token)],
    );
    return r.rows[0] as { incident_id: string; share_location: boolean } | undefined;
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function humanTransitionError(event: IncidentEvent, state: IncidentState, fallback: string): string {
  if (event === 'arrive' && (state === 'offered' || state === 'received')) return 'You cannot mark this on scene before you accept.';
  if (event === 'accept' && state !== 'offered') return 'Another unit accepted this report.';
  if (state === 'resolved' || state === 'unfounded' || state === 'cancelled') return 'This report is already closed.';
  return fallback;
}

