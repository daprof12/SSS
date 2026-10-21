import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Sse, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { availableEvents, citizenStatus, ForbiddenView, incidentMachine, projectIncident, type IncidentActor, type IncidentEvent, type Viewer } from '@erp/domain';
import { CurrentUser, hasRole, Public, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db } from '../core/db';
import { AppError, ZodPipe } from '../core/http';
import { IncidentRepo } from './incident.repo';
import { IncidentsService } from './incidents.service';

const CreateBody = z
  .object({
    type: z.enum(['fire', 'robbery', 'kidnapping', 'riot', 'violence', 'medical', 'accident', 'other']),
    postcode: z.string().trim().min(3).max(12).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    clientRef: z.string().min(8).max(80),
    discreet: z.boolean().optional(),
  })
  .refine((b) => b.postcode || (b.lat != null && b.lng != null), { message: 'Turn on location so help can find you, or pick your building on the map.', path: ['postcode'] });

const CancelBody = z.object({ reason: z.enum(['mistake', 'resolved_myself', 'help_arrived_other', 'unsafe_to_wait', 'other']) });
const ActBody = z.object({
  event: z.enum(['accept', 'start_route', 'arrive', 'officer_drop', 'transfer', 'begin_close', 'close_valid', 'close_unfounded']),
  reason: z.string().trim().max(500).optional(),
  outcomeCode: z.string().trim().max(40).optional(),
  targetStationId: z.string().uuid().optional(),
  etaMinutes: z.number().int().min(0).max(240).optional(),
});
const DeclineBody = z.object({ reason: z.string() });
const Other = z.object({ otherId: z.string().uuid() });
const SplitBody = z.object({ reportId: z.string().uuid() });
const AssignBody = z.object({ officerId: z.string().uuid() });
const RATING_TAGS = ['fast', 'polite', 'clear', 'professional', 'slow', 'rude', 'unclear'] as const;
const RatingBody = z.object({
  stars: z.number().int().min(1, 'Choose 1 to 5 stars.').max(5, 'Choose 1 to 5 stars.'),
  tags: z.array(z.enum(RATING_TAGS)).max(7).default([]),
  comment: z.string().max(1000, 'Keep it under 1000 characters.').optional(),
});
const SideBody = z.object({
  kind: z.enum(['add_info', 'note', 'reinforce', 'officer_panic', 'panic_cleared', 'drone_requested', 'transfer_requested']),
  text: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(500).optional(),
});

@Controller()
export class IncidentsController {
  constructor(
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
    @Inject(IncidentRepo) private readonly repo: IncidentRepo,
    @Inject(Bus) private readonly bus: Bus,
    @Inject(Db) private readonly db: Db,
  ) {}

  @Post('incidents')
  create(@CurrentUser() p: Principal, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.incidents.create(p, body);
  }

  @Get('me/incidents')
  async mine(@CurrentUser() p: Principal) {
    const r = await this.db.query(
      `select distinct on (i.id) i.id, i.type, i.state, i.created_at, ir.role
         from incident_reports ir join incidents i on i.id = ir.incident_id
        where ir.reporter_id = $1 order by i.id, ir.created_at`,
      [p.userId],
    );
    // Open reports first (Activity pins them), then newest.
    const open = new Set(['pending_cancel', 'received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred', 'on_scene', 'closing']);
    return r.rows
      .map((x) => ({ id: x.id, type: x.type, state: x.state, role: x.role, createdAt: x.created_at, open: open.has(x.state), status: citizenStatus(x.state).title }))
      .sort((a, b) => Number(b.open) - Number(a.open) || +new Date(b.createdAt) - +new Date(a.createdAt));
  }

  /** Station queue: open incidents for every station the caller heads or dispatches for. */
  @Get('me/queue')
  async queue(@CurrentUser() p: Principal) {
    const stations = this.staffStations(p);
    const r = await this.db.query(
      `select i.id, i.type, i.state, i.report_count, i.created_at, i.updated_at, l.postcode, l.area_label,
              (select ou.display_name from incident_units u join users ou on ou.id = u.officer_id
                where u.incident_id = i.id and u.state in ('offered', 'accepted', 'en_route', 'on_scene') order by u.offered_at desc limit 1) as officer,
              (select u.offer_expires_at from incident_units u where u.incident_id = i.id and u.state = 'offered' order by u.offered_at desc limit 1) as offer_expires_at,
              coalesce(t.band, 'normal') as trust_band, it.severity
         from incidents i
         join incident_types it on it.code = i.type
         left join locations l on l.id = i.location_id
         left join trust_scores t on t.user_id = i.reporter_id
        where i.station_id = any($1::uuid[])
          and i.state not in ('pending_cancel', 'resolved', 'unfounded', 'cancelled', 'merged')
        order by it.severity desc, i.created_at`,
      [stations],
    );
    return r.rows.map((x) => ({
      id: x.id,
      type: x.type,
      state: x.state,
      reportCount: x.report_count,
      postcode: x.postcode,
      area: x.area_label,
      officer: x.officer,
      offerExpiresAt: x.offer_expires_at,
      trustBand: x.trust_band,
      severity: x.severity,
      createdAt: x.created_at,
      updatedAt: x.updated_at,
    }));
  }

  @Get('incidents/:id/duplicates')
  duplicates(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.incidents.duplicates(p, id);
  }

  @Post('incidents/:id/merge')
  merge(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Other)) b: z.infer<typeof Other>) {
    return this.incidents.mergeIn(p, id, b.otherId);
  }

  @Post('incidents/:id/keep-separate')
  keep(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Other)) b: z.infer<typeof Other>) {
    return this.incidents.keepSeparate(p, id, b.otherId);
  }

  @Post('incidents/:id/split')
  split(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SplitBody)) b: z.infer<typeof SplitBody>) {
    return this.incidents.split(p, id, b.reportId);
  }

  @Get('incidents/:id/offer')
  offer(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.incidents.offerStatus(p, id);
  }

  @Get('incidents/:id')
  view(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.render(p, id);
  }

  /** A6: each subscriber gets its own filtered view, rebuilt on every change. */
  @Sse('incidents/:id/stream')
  stream(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let closed = false;
      const push = async () => {
        try {
          const data = await this.render(p, id);
          if (!closed) sub.next({ type: 'incident', data });
        } catch (e) {
          // Access can end mid-stream (offer expired, transfer, deleted). Send a final
          // "gone" event and complete, so the client stops reconnecting instead of spinning.
          if (closed) return;
          const message = e instanceof AppError ? (e.getResponse() as { message?: string }).message : undefined;
          sub.next({ type: 'gone', data: { message: message ?? 'This report is no longer available to you.' } });
          sub.complete();
        }
      };
      void push();
      const off = this.bus.onIncident(id, () => void push());
      const beat = setInterval(() => sub.next({ type: 'heartbeat', data: { at: new Date().toISOString() } }), 15000);
      return () => {
        closed = true;
        off();
        clearInterval(beat);
      };
    });
  }

  @Post('incidents/:id/cancel')
  cancel(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CancelBody)) b: z.infer<typeof CancelBody>) {
    return this.incidents.cancel(p, id, b.reason);
  }

  @Post('incidents/:id/actions')
  async act(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ActBody)) b: z.infer<typeof ActBody>) {
    const state = await this.incidents.act(p, id, b.event, b);
    return { state };
  }

  @Post('incidents/:id/assign')
  async assign(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AssignBody)) b: z.infer<typeof AssignBody>) {
    return { state: await this.incidents.assign(p, id, b.officerId) };
  }

  /** Officers at my station with what each is doing now — feeds the Assign sheet. */
  @Get('me/station/officers')
  async stationOfficers(@CurrentUser() p: Principal, @Query('near') near?: string) {
    const stations = this.staffStations(p);
    const inc = near ? (await this.db.query(`select geom from incidents where id = $1 and station_id = any($2::uuid[])`, [near, stations])).rows[0] : null;
    const r = await this.db.query(
      `select o.user_id as id, u.display_name as name, o.badge_no, o.rank, o.on_duty, o.badge_status,
              (select i.type || ', ' || coalesce(l.postcode, 'GPS') from incident_units x join incidents i on i.id = x.incident_id
                 left join locations l on l.id = i.location_id
                where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene') limit 1) as current_task,
              case when $2::geography is not null and o.last_location is not null then round(st_distance(o.last_location, $2::geography))::int end as distance_m
         from officers o join users u on u.id = o.user_id
        where o.station_id = any($1::uuid[])
        order by o.on_duty desc, distance_m nulls last, u.display_name`,
      [stations, inc?.geom ?? null],
    );
    return r.rows.map((o) => ({
      id: o.id,
      name: o.name,
      badgeNo: o.badge_no,
      rank: o.rank,
      onDuty: o.on_duty,
      badgeVerified: o.badge_status === 'verified',
      currentTask: o.current_task,
      distanceM: o.distance_m,
      available: o.on_duty && o.badge_status === 'verified' && !o.current_task,
    }));
  }

  /** Stations a report can be transferred to: other active stations of live agencies. */
  @Get('me/station/transfer-targets')
  async transferTargets(@CurrentUser() p: Principal) {
    const stations = this.staffStations(p);
    const r = await this.db.query(
      `select s.id, s.name, a.name as agency, a.kind from stations s join agencies a on a.id = s.agency_id
        where s.status = 'active' and a.status = 'live' and not (s.id = any($1::uuid[])) order by a.name, s.name`,
      [stations],
    );
    return r.rows;
  }

  private staffStations(p: Principal): string[] {
    const s = p.roles.filter((r) => (r.role === 'head' || r.role === 'dispatcher') && r.scopeId).map((r) => r.scopeId!);
    if (!s.length) throw new AppError(403, 'not_station_staff', 'This page is for station staff.');
    return s;
  }

  @Post('incidents/:id/rating')
  rate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RatingBody)) b: z.infer<typeof RatingBody>) {
    return this.incidents.rate(p, id, b);
  }

  @Post('incidents/:id/decline')
  decline(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DeclineBody)) b: z.infer<typeof DeclineBody>) {
    return this.incidents.decline(p, id, b.reason);
  }

  @Post('incidents/:id/events')
  side(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SideBody)) b: z.infer<typeof SideBody>) {
    return this.incidents.sideEvent(p, id, b.kind, b);
  }

  /** Emergency contact page (no account): area, status and ETA only. */
  @Public()
  @Get('track/:token')
  async track(@Param('token') token: string, @Query() _q: unknown) {
    const link = await this.incidents.trackingLink(token);
    if (!link) throw new AppError(404, 'link_expired', 'This link has expired.');
    const rec = await this.repo.record(link.incident_id);
    if (!rec) throw new AppError(404, 'link_expired', 'This link has expired.');
    return projectIncident(rec, { kind: 'contact', reporterOptedInLocation: link.share_location });
  }

  private async render(p: Principal, id: string) {
    const rec = await this.repo.record(id);
    if (!rec) throw new AppError(404, 'not_found', 'This report could not be found.');
    const viewer = this.viewerFor(p, rec);
    let view;
    try {
      view = projectIncident(rec, viewer);
    } catch (e) {
      if (e instanceof ForbiddenView) throw new AppError(404, 'not_found', 'This report could not be found.');
      throw e;
    }
    const row = await this.repo.row(id);
    const actors: IncidentActor[] = row ? await this.incidents.actorsFor(p, row) : [];
    const actions = [...new Set(actors.flatMap((a) => availableEvents(incidentMachine, rec.state, a)))] as IncidentEvent[];
    const status =
      viewer.kind === 'reporter' || viewer.kind === 'joiner'
        ? citizenStatus(rec.state, {
            officerName: rec.officer?.name,
            stationName: rec.officer?.stationName,
            etaMinutes: rec.etaMinutes,
            reportCount: rec.reportCount,
            joined: viewer.kind === 'joiner' || rec.reportCount > 1,
          })
        : undefined;
    return { ...view, status, actions, serverTime: new Date().toISOString() };
  }

  private viewerFor(p: Principal, rec: { reporter: { userId: string }; joinerUserIds: string[]; assignedOfficerIds: string[]; stationId?: string; agencyId: string }): Viewer {
    if (rec.reporter.userId === p.userId) return { kind: 'reporter', userId: p.userId };
    if (rec.joinerUserIds.includes(p.userId)) return { kind: 'joiner', userId: p.userId };
    if (rec.assignedOfficerIds.includes(p.userId)) return { kind: 'officer', userId: p.userId };
    const st = p.roles.find((r) => (r.role === 'head' || r.role === 'dispatcher') && r.scopeId === rec.stationId);
    if (st && rec.stationId) return { kind: 'station', stationId: rec.stationId };
    const ag = p.roles.find((r) => r.role === 'agency_admin' && r.scopeId === rec.agencyId);
    if (ag) return { kind: 'agency', agencyId: rec.agencyId };
    if (hasRole(p, 'platform_admin')) return { kind: 'platform_admin' };
    // Unknown viewer: projection throws ForbiddenView → 404 (no existence leak).
    return { kind: 'reporter', userId: p.userId };
  }
}
