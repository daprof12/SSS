import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { DateRangeQuery, type DateRange } from '../core/date-range';
import { ZodPipe } from '../core/http';
import { LocationQuery } from '../core/location-filter';
import { OverviewService } from './overview.service';
import { StationService } from './station.service';

const Duty = z.object({ on: z.boolean() });
const Reinforce = z.object({ officerId: z.string().uuid() });
const Days = z.coerce.number().int().refine((n) => [7, 30, 90].includes(n), 'Choose 7, 30 or 90 days.').default(30);
const Week = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const Shift = z.object({ officerId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['day', 'night', 'off', 'leave']) });
const WeekBody = z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const Message = z.object({
  audience: z.enum(['on_duty', 'everyone', 'officer']),
  officerId: z.string().uuid().optional(),
  title: z.string().trim().min(1, 'Give it a title.').max(120),
  body: z.string().trim().min(1, 'Write a message before sending.').max(2000),
  urgent: z.boolean().default(false),
  needsConfirm: z.boolean().default(false),
  test: z.boolean().default(false),
  sms: z.enum(['off', 'now', 'unread']).optional(),
  smsAfterMinutes: z.number().int().min(1).max(240).optional(),
  whatsapp: z.boolean().default(false),
});
const RosterReq = z.object({
  kind: z.enum(['swap', 'leave']),
  otherOfficerId: z.string().uuid().optional(),
  myDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  otherDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(500).optional(),
});
const Decide = z.object({ decision: z.enum(['approve', 'decline']), reason: z.string().max(500).optional() });
const Areas = z.object({
  areas: z.array(z.object({ level: z.enum(['lga', 'district', 'area']), areaId: z.string().trim().min(2).max(60), label: z.string().trim().max(120).optional() })).max(50),
});
const Settings = z.object({
  phone: z.string().max(20).optional(),
  acceptWindowSeconds: z.number().int().optional(),
  minOnDuty: z.number().int().optional(),
  dayStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  nightStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  openingHours: z.enum(['always', 'office']).optional(),
  ifNobodyAccepts: z.enum(['next_officer_then_station', 'next_station']).optional(),
  alerts: z.record(z.boolean()).optional(),
});
const UsersQ = LocationQuery.extend({ role: z.enum(['all', 'citizens', 'owners', 'officers', 'heads', 'technicians', 'staff']).default('all'), q: z.string().max(60).optional() });
const LiveQ = LocationQuery.extend({ kinds: z.string().optional() });
const SubsQ = LocationQuery.extend({ status: z.string().default('all') });
const kindsOf = (s?: string) => (s ?? '').split(',').filter((k): k is 'emergency' | 'tip' | 'issue' => ['emergency', 'tip', 'issue'].includes(k));
const SubAct = z.object({ action: z.enum(['remind', 'pause', 'resume', 'change_plan']), planCode: z.string().optional(), reason: z.string().max(500).optional() });
const Kyc = z.object({ decision: z.enum(['approve', 'reject', 'more']), reason: z.string().max(500).optional() });

@Controller()
export class DashboardsController {
  constructor(
    @Inject(StationService) private readonly station: StationService,
    @Inject(OverviewService) private readonly overview: OverviewService,
  ) {}

  // Station
  @Get('me/station/summary')
  summary(@CurrentUser() p: Principal) {
    return this.station.summary(p);
  }

  @Get('me/station/map')
  map(@CurrentUser() p: Principal) {
    return this.station.map(p);
  }

  @Get('me/station/team')
  team(@CurrentUser() p: Principal) {
    return this.station.officers(p);
  }

  @Post('me/station/officers/:id/duty')
  @HttpCode(200)
  duty(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Duty)) b: z.infer<typeof Duty>) {
    return this.station.setDuty(p, id, b.on);
  }

  @Post('incidents/:id/reinforce')
  reinforce(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Reinforce)) b: z.infer<typeof Reinforce>) {
    return this.station.reinforce(p, id, b.officerId);
  }

  @Get('incidents/:id/station-detail')
  extras(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.station.incidentExtras(p, id);
  }

  @Get('me/station/reports')
  reports(@CurrentUser() p: Principal, @Query('days', new ZodPipe(Days)) days: number, @Query(new ZodPipe(DateRangeQuery)) r: DateRange) {
    return this.station.reports(p, days, r);
  }

  @Get('me/station/roster')
  roster(@CurrentUser() p: Principal, @Query('week', new ZodPipe(Week)) week?: string) {
    return this.station.roster(p, week);
  }

  @Put('me/station/roster')
  shift(@CurrentUser() p: Principal, @Body(new ZodPipe(Shift)) b: z.infer<typeof Shift>) {
    return this.station.setShift(p, b);
  }

  @Post('me/station/roster/copy-last-week')
  copy(@CurrentUser() p: Principal, @Body(new ZodPipe(WeekBody)) b: z.infer<typeof WeekBody>) {
    return this.station.copyLastWeek(p, b.week);
  }

  @Post('me/station/roster/publish')
  publish(@CurrentUser() p: Principal, @Body(new ZodPipe(WeekBody)) b: z.infer<typeof WeekBody>) {
    return this.station.publish(p, b.week);
  }

  @Get('me/station/roster/requests')
  rosterRequests(@CurrentUser() p: Principal) {
    return this.station.stationRequests(p);
  }

  @Post('me/station/roster/requests/:id')
  @HttpCode(200)
  decideRequest(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>) {
    return this.station.decide(p, id, b);
  }

  @Get('me/officer/roster-requests')
  myRequests(@CurrentUser() p: Principal) {
    return this.station.myRequests(p);
  }

  @Post('me/officer/roster-requests')
  askRoster(@CurrentUser() p: Principal, @Body(new ZodPipe(RosterReq)) b: z.infer<typeof RosterReq>) {
    return this.station.request(p, b);
  }

  @Post('me/officer/roster-requests/:id/withdraw')
  @HttpCode(200)
  withdraw(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.station.withdraw(p, id);
  }

  @Get('me/station/messages')
  messages(@CurrentUser() p: Principal) {
    return this.station.messages(p);
  }

  @Get('me/station/messages/:id')
  messageDetail(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.station.messageDetail(p, id);
  }

  @Post('me/station/messages')
  send(@CurrentUser() p: Principal, @Body(new ZodPipe(Message)) b: z.infer<typeof Message>) {
    return this.station.send(p, b);
  }

  @Post('me/station/messages/:id/resend')
  resend(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.station.resend(p, id);
  }

  @Get('me/station/settings')
  settings(@CurrentUser() p: Principal) {
    return this.station.settings(p);
  }

  @Patch('me/station/settings')
  saveSettings(@CurrentUser() p: Principal, @Body(new ZodPipe(Settings)) b: z.infer<typeof Settings>) {
    return this.station.saveSettings(p, b);
  }

  @Put('me/station/areas')
  saveAreas(@CurrentUser() p: Principal, @Body(new ZodPipe(Areas)) b: z.infer<typeof Areas>) {
    return this.station.saveAreas(p, b.areas);
  }

  // Officer: a station message
  @Get('me/messages/:id')
  officerMessage(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.station.officerMessage(p, id);
  }

  @Post('me/messages/:id/confirm')
  @HttpCode(200)
  confirmMessage(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.station.officerMessage(p, id, true);
  }

  // Agency
  @Get('agencies/:agencyId/overview')
  agencyOverview(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query(new ZodPipe(DateRangeQuery)) r: DateRange) {
    return this.overview.agencyOverview(p, a, r);
  }

  @Get('agencies/:agencyId/station-list')
  agencyStations(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.overview.agencyStations(p, a);
  }

  // Platform admin
  @Get('admin/overview')
  adminOverview(@CurrentUser() p: Principal, @Query(new ZodPipe(LocationQuery)) f: z.infer<typeof LocationQuery>, @Query(new ZodPipe(DateRangeQuery)) r: DateRange) {
    return this.overview.adminOverview(p, f, r);
  }

  @Get('admin/users')
  users(@CurrentUser() p: Principal, @Query(new ZodPipe(UsersQ)) q: z.infer<typeof UsersQ>) {
    return this.overview.users(p, q);
  }

  @Get('admin/subscriptions')
  subscriptions(@CurrentUser() p: Principal, @Query(new ZodPipe(SubsQ)) q: z.infer<typeof SubsQ>) {
    return this.overview.subscriptions(p, q.status, q);
  }

  @Post('admin/subscriptions/:id')
  @HttpCode(200)
  subAct(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SubAct)) b: z.infer<typeof SubAct>) {
    return this.overview.subscriptionAction(p, id, b);
  }

  @Get('admin/kyc')
  kyc(@CurrentUser() p: Principal, @Query(new ZodPipe(LocationQuery)) f: z.infer<typeof LocationQuery>) {
    return this.overview.kycQueue(p, f);
  }

  @Post('admin/kyc/:id')
  @HttpCode(200)
  kycDecide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Kyc)) b: z.infer<typeof Kyc>) {
    return this.overview.kycDecide(p, id, b);
  }

  @Get('admin/live')
  live(@CurrentUser() p: Principal, @Query(new ZodPipe(LiveQ)) q: z.infer<typeof LiveQ>) {
    return this.overview.live(p, { agencyId: null }, kindsOf(q.kinds), q);
  }

  @Get('agencies/:agencyId/live')
  agencyLive(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query(new ZodPipe(LiveQ)) q: z.infer<typeof LiveQ>) {
    return this.overview.live(p, { agencyId: a }, kindsOf(q.kinds), q);
  }
}
