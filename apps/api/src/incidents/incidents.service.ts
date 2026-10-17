import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import {
  applyIncidentEvent,
  assessReporterCancel,
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
import { hasRole, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { CONFIG, type AppConfig } from '../core/config';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { IncidentRepo, type IncidentRow } from './incident.repo';

/** Citizen-facing timeline labels; events not listed here stay internal. */
const PUBLIC_LABELS: Partial<Record<string, string>> = {
  window_elapsed: 'Report received',
  route: 'Sent to the nearest team',
  assign: 'Sent to a team',
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
export class IncidentsService implements OnModuleDestroy {
  private readonly log = new Logger('Incidents');
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(IncidentRepo) private readonly repo: IncidentRepo,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
    @Inject(SMS) private readonly sms: SmsAdapter,
  ) {}

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
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
    if (lat == null || lng == null) throw new AppError(422, 'location_required', 'Turn on location so help can find you, or type your postcode.');

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
    // Production: a durable job queue (TRD: NATS/Kafka); in-process timers are for the foundation only.
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
      return { into: target };
    }, { merged_into: target, merge_reason: 'same_building' });
    this.publish(target, 'report_joined');
    return true;
  }

  /** Picks a station and the nearest on-duty, verified, free officer. */
  async route(id: string, exclude: string[] = []) {
    const row = await this.repo.row(id);
    if (!row || !['received', 'escalated', 'reassigning', 'transferred'].includes(row.state)) return;

    const station = row.station_id
      ? { id: row.station_id }
      : (
          await this.db.query(
            `select s.id, s.agency_id from stations s
               join agencies a on a.id = s.agency_id and a.status = 'live'
               join incident_types t on t.code = $1 and a.kind = any(t.default_units)
               left join routing_rules r on r.station_id = s.id and r.incident_type = $1
              where s.status = 'active'
              order by r.priority nulls last, st_distance(coalesce(s.zone::geometry, (select geom::geometry from locations where id = s.location_id))::geography,
                                                          st_setsrid(st_makepoint($3, $2), 4326)::geography)
              limit 1`,
            [row.type, row.lat, row.lng],
          )
        ).rows[0];

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
      await this.db.query(`insert into incident_events (incident_id, actor_kind, kind, payload) values ($1, 'system', 'no_responder', $2)`, [id, { stationId: station.id }]);
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
    };
    if (!who[kind]) throw new AppError(400, 'unsupported_event', 'That action is not available here.');
    const { row, actor } = await this.pickActor(p, id, kind, who[kind]!);
    if (!sideEventAllowedIn[kind].includes(row.state)) throw new AppError(409, 'invalid_transition', 'That action is not available at this stage.');
    if ((kind === 'note' || kind === 'add_info') && !payload.text?.trim()) throw new AppError(422, 'text_required', 'Write a note before saving.');
    if (kind === 'reinforce' && !payload.reason?.trim()) throw new AppError(422, 'reason_required', 'Say why you need help.');
    const label = kind === 'officer_panic' ? 'Officer needs help' : PUBLIC_LABELS[kind] ?? kind;
    await this.logEvent(this.db.pool, id, p.userId, actor, kind, null, null, { ...payload, label }, kind === 'reinforce');
    if (kind === 'officer_panic') {
      await this.audit.write({ actorId: p.userId, actorRole: 'officer', action: 'incident.officer_panic', entity: 'incident', entityId: id });
    }
    this.publish(id, kind);
    return { ok: true };
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
        return to;
      }
    }
    throw new AppError(400, 'unsupported_event', 'That action is not available here.');
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
    await this.db.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload) values ($1, $2, 'officer', 'declined', $3)`, [id, p.userId, { reason }]);
    await this.transition(id, 'offer_timeout', 'system', null);
    await this.route(id, [p.userId]);
    return { ok: true };
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

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function humanTransitionError(event: IncidentEvent, state: IncidentState, fallback: string): string {
  if (event === 'arrive' && (state === 'offered' || state === 'received')) return 'You cannot mark this on scene before you accept.';
  if (event === 'accept' && state !== 'offered') return 'Another unit accepted this report.';
  if (state === 'resolved' || state === 'unfounded' || state === 'cancelled') return 'This report is already closed.';
  return fallback;
}

