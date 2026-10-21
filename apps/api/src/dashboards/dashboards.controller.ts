import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
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
const UsersQ = z.object({ role: z.enum(['all', 'citizens', 'owners', 'officers', 'heads', 'technicians', 'staff']).default('all'), q: z.string().max(60).optional() });
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
  reports(@CurrentUser() p: Principal, @Query('days', new ZodPipe(Days)) days: number) {
    return this.station.reports(p, days);
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
  agencyOverview(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.overview.agencyOverview(p, a);
  }

  @Get('agencies/:agencyId/station-list')
  agencyStations(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.overview.agencyStations(p, a);
  }

  // Platform admin
  @Get('admin/overview')
  adminOverview(@CurrentUser() p: Principal) {
    return this.overview.adminOverview(p);
  }

  @Get('admin/users')
  users(@CurrentUser() p: Principal, @Query(new ZodPipe(UsersQ)) q: z.infer<typeof UsersQ>) {
    return this.overview.users(p, q);
  }

  @Get('admin/subscriptions')
  subscriptions(@CurrentUser() p: Principal, @Query('state') state = 'all') {
    return this.overview.subscriptions(p, state);
  }

  @Post('admin/subscriptions/:id')
  @HttpCode(200)
  subAct(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SubAct)) b: z.infer<typeof SubAct>) {
    return this.overview.subscriptionAction(p, id, b);
  }

  @Get('admin/kyc')
  kyc(@CurrentUser() p: Principal) {
    return this.overview.kycQueue(p);
  }

  @Post('admin/kyc/:id')
  @HttpCode(200)
  kycDecide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Kyc)) b: z.infer<typeof Kyc>) {
    return this.overview.kycDecide(p, id, b);
  }

  @Get('admin/live')
  live(@CurrentUser() p: Principal) {
    return this.overview.liveMap(p);
  }
}
