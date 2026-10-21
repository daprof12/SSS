import { Body, Controller, Get, Inject, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { LocationQuery } from '../core/location-filter';
import { AdminOpsService, STOCK_ITEMS } from './admin-ops.service';
import { AdminOversightService } from './admin-oversight.service';

const Coverage = LocationQuery.extend({ type: z.enum(['camera', 'street_light', 'gateway', 'drone']).optional(), status: z.enum(['online', 'low_power', 'offline', 'needs_repair', 'tamper', 'not_covered']).optional() });
const Wall = LocationQuery.extend({ tab: z.enum(['all', 'cameras', 'lights', 'offline', 'low_power', 'tamper']).optional() });
const Agencies = LocationQuery.extend({ kind: z.string().max(20).optional() });
const Note = z.object({ note: z.string().trim().max(500).optional() });
const Reason = z.object({ reason: z.string().trim().max(200) });
const Light = z.object({ action: z.enum(['on', 'flash']) });
const Visit = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a day.'), window: z.enum(['morning', 'afternoon']), note: z.string().trim().max(500).optional() });
const Qty = z.number({ invalid_type_error: 'Enter a number.' }).int('Whole units only.').min(1, 'At least 1.').max(10_000);
const AddStock = z.object({ storeId: z.string().uuid('Choose a store.'), item: z.enum(STOCK_ITEMS), quantity: Qty, note: z.string().trim().max(200).optional() });
const Transfer = z.object({ from: z.string().uuid('Choose a store.'), to: z.string().uuid('Choose a store.'), item: z.enum(STOCK_ITEMS), quantity: Qty, note: z.string().trim().max(200).optional() });
const AuditQ = z.object({
  days: z.coerce.number().int().refine((d) => [1, 7, 30, 90].includes(d)).optional(),
  actor: z.string().uuid().optional(),
  action: z.string().max(20).optional(),
  postcode: z.string().max(20).optional(),
});
const AiSettingsB = z.object({
  provider: z.string().trim().min(2).max(60).optional(),
  primary: z.string().trim().min(2).max(80).optional(),
  fallback: z.string().trim().min(2).max(80).optional(),
  region: z.string().trim().min(2).max(40).optional(),
  monthlyLimitKobo: z.number().int().min(0).max(10_000_000_000).optional(),
});
const AiSwitch = z.object({ paused: z.boolean().optional(), translationPaused: z.boolean().optional(), useFallback: z.boolean().optional() });
const UseCase = z.object({ status: z.enum(['live', 'testing', 'paused']) });
const Decide = z.object({ decision: z.enum(['looks_right', 'note', 'translator', 'rerecord']), note: z.string().trim().max(1000).optional() });
const Audience = LocationQuery.extend({ who: z.array(z.enum(['citizen', 'officer', 'head', 'agency_admin'])).max(4), agencyId: z.string().uuid().optional() });
const Channels = z.array(z.enum(['push', 'sms', 'whatsapp'])).min(1, 'Choose how it is sent.');
const AudienceB = Audience.extend({ kind: z.enum(['marketing', 'safety']).optional(), channels: Channels.optional() });
const Compose = z.object({
  action: z.enum(['draft', 'request_approval', 'schedule', 'send', 'test']),
  title: z.string().trim().min(1, 'Add a title.').max(120),
  body: z.string().trim().min(1, 'Write a message.').max(1000),
  kind: z.enum(['marketing', 'safety']),
  urgent: z.boolean().optional(),
  audience: Audience,
  channels: Channels,
  languages: z.array(z.enum(['en', 'pcm', 'yo', 'ha', 'ig'])).max(5).optional(),
  link: z.string().trim().max(200).optional(),
  sendAt: z.string().datetime({ offset: true }).optional(),
});

/** Platform admin boards: coverage, devices, inventory, agencies, donations, audit, AI and CRM. */
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AdminOpsService) private readonly ops: AdminOpsService,
    @Inject(AdminOversightService) private readonly over: AdminOversightService,
  ) {}

  @Get('coverage')
  coverage(@CurrentUser() p: Principal, @Query(new ZodPipe(Coverage)) q: z.infer<typeof Coverage>) {
    return this.ops.coverage(p, q);
  }

  @Post('devices/:id/technician')
  technician(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Note)) b: z.infer<typeof Note>) {
    return this.ops.sendTechnician(p, id, b.note);
  }

  @Post('devices/:id/alert-station')
  alertStation(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.alertStation(p, id);
  }

  @Get('device-wall')
  wall(@CurrentUser() p: Principal, @Query(new ZodPipe(Wall)) q: z.infer<typeof Wall>) {
    return this.ops.deviceWall(p, q);
  }

  @Get('households/:id')
  household(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.household(p, id);
  }

  @Post('households/:id/visit')
  visit(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Visit)) b: z.infer<typeof Visit>) {
    return this.ops.scheduleVisit(p, id, b);
  }

  @Post('devices/:id/live')
  live(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Reason)) b: z.infer<typeof Reason>) {
    return this.ops.liveView(p, id, b.reason);
  }

  @Post('devices/:id/light')
  light(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Light)) b: z.infer<typeof Light>) {
    return this.ops.light(p, id, b.action);
  }

  @Get('inventory')
  inventory(@CurrentUser() p: Principal, @Query(new ZodPipe(LocationQuery)) q: z.infer<typeof LocationQuery>) {
    return this.ops.inventory(p, q);
  }

  @Post('inventory/stock')
  addStock(@CurrentUser() p: Principal, @Body(new ZodPipe(AddStock)) b: z.infer<typeof AddStock>) {
    return this.ops.addStock(p, b);
  }

  @Post('inventory/transfer')
  transfer(@CurrentUser() p: Principal, @Body(new ZodPipe(Transfer)) b: z.infer<typeof Transfer>) {
    return this.ops.transferStock(p, b);
  }

  @Get('agencies-board')
  agencies(@CurrentUser() p: Principal, @Query(new ZodPipe(Agencies)) q: z.infer<typeof Agencies>) {
    return this.ops.agencies(p, q);
  }

  @Get('donations')
  donations(@CurrentUser() p: Principal, @Query(new ZodPipe(LocationQuery)) q: z.infer<typeof LocationQuery>) {
    return this.ops.donations(p, q);
  }

  @Post('donations/payout')
  runPayout(@CurrentUser() p: Principal) {
    return this.ops.runDonationPayout(p);
  }

  // ---------------------------------------------------------------- audit

  @Get('audit')
  audit(@CurrentUser() p: Principal, @Query(new ZodPipe(AuditQ)) q: z.infer<typeof AuditQ>) {
    return this.over.auditLog(p, q);
  }

  @Get('audit.csv')
  async auditCsv(@CurrentUser() p: Principal, @Query(new ZodPipe(AuditQ)) q: z.infer<typeof AuditQ>, @Res() res: Response) {
    const csv = await this.over.auditCsv(p, q);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"', 'Cache-Control': 'private, no-store' }).send(csv);
  }

  @Get('audit/:id')
  entry(@CurrentUser() p: Principal, @Param('id', ParseIntPipe) id: number) {
    return this.over.auditEntry(p, id);
  }

  // ---------------------------------------------------------------- AI

  @Get('ai')
  ai(@CurrentUser() p: Principal) {
    return this.over.ai(p);
  }

  @Put('ai/settings')
  aiSettings(@CurrentUser() p: Principal, @Body(new ZodPipe(AiSettingsB)) b: z.infer<typeof AiSettingsB>) {
    return this.over.saveAiSettings(p, b);
  }

  @Post('ai/switch')
  aiSwitch(@CurrentUser() p: Principal, @Body(new ZodPipe(AiSwitch)) b: z.infer<typeof AiSwitch>) {
    return this.over.aiSwitch(p, b);
  }

  @Put('ai/use-cases/:code')
  useCase(@CurrentUser() p: Principal, @Param('code') code: string, @Body(new ZodPipe(UseCase)) b: z.infer<typeof UseCase>) {
    return this.over.setUseCase(p, code, b.status);
  }

  @Get('ai/reviews')
  reviews(@CurrentUser() p: Principal) {
    return this.over.reviewQueue(p);
  }

  @Get('ai/reviews/:statementId')
  review(@CurrentUser() p: Principal, @Param('statementId', ParseUUIDPipe) id: string) {
    return this.over.review(p, id);
  }

  @Post('ai/reviews/:statementId')
  decide(@CurrentUser() p: Principal, @Param('statementId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>) {
    return this.over.decideReview(p, id, b);
  }

  // ---------------------------------------------------------------- CRM

  @Post('crm/audience')
  audience(@CurrentUser() p: Principal, @Body(new ZodPipe(AudienceB)) b: z.infer<typeof AudienceB>) {
    return this.over.audienceSize(p, b);
  }

  @Post('crm/campaigns')
  compose(@CurrentUser() p: Principal, @Body(new ZodPipe(Compose)) b: z.infer<typeof Compose>) {
    return this.over.compose(p, b);
  }

  @Get('crm/campaigns')
  campaigns(@CurrentUser() p: Principal) {
    return this.over.campaigns(p);
  }

  @Get('crm/consent')
  consent(@CurrentUser() p: Principal) {
    return this.over.consent(p);
  }

  @Get('crm/campaigns/:id')
  campaign(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.over.campaign(p, id);
  }

  @Get('crm/campaigns/:id/results.csv')
  async resultsCsv(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const csv = await this.over.resultsCsv(p, id);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="campaign-results.csv"', 'Cache-Control': 'private, no-store' }).send(csv);
  }

  @Post('crm/campaigns/:id/approve')
  approve(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.over.approve(p, id);
  }

  @Post('crm/campaigns/:id/resend')
  resend(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.over.resend(p, id);
  }

  @Post('crm/campaigns/:id/duplicate')
  duplicate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.over.duplicate(p, id);
  }
}
