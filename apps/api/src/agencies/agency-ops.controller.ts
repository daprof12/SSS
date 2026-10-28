import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { LocationQuery } from '../core/location-filter';
import { AdminOversightService } from '../dashboards/admin-oversight.service';
import { AGENCY_TEAM_ROLES, ASSET_KIND, AgencyOpsService, EQUIPMENT, type AssetKind } from './agency-ops.service';

const Phone = z.string().trim().min(8, 'Enter a phone number.').max(20);
const Invite = z.object({
  name: z.string().trim().min(2, 'Enter their full name.').max(120),
  serviceNo: z.string().trim().min(2, 'Enter the service number.').max(40),
  phone: Phone,
  stationId: z.string().uuid('Choose a station.'),
  role: z.enum(['officer', 'head']).default('officer'),
});
const Equip = z.object({
  kind: z.enum(Object.keys(EQUIPMENT) as [keyof typeof EQUIPMENT, ...Array<keyof typeof EQUIPMENT>]),
  name: z.string().trim().max(80).optional(),
  quantity: z.number().int().min(1, 'At least 1.').max(500),
  stationId: z.string().uuid().optional(),
  pilotName: z.string().trim().max(120).optional(),
});
const EquipPatch = z.object({
  status: z.enum(['ready', 'in_use', 'needs_service', 'out_of_service']).optional(),
  checked: z.boolean().optional(),
  pilotName: z.string().trim().max(120).optional(),
  remove: z.boolean().optional(),
});
const Rule = z.object({
  incidentType: z.string().min(2, 'Choose a report type.').max(40),
  areaId: z.string().trim().max(60).nullable().optional(),
  stationId: z.string().uuid('Choose the first station.'),
  nextStationId: z.string().uuid().nullable().optional(),
  waitSeconds: z.number().int().min(10, 'At least 10 seconds.').max(300),
  priority: z.number().int().min(1).max(20).default(1),
  active: z.boolean().optional(),
});
const Defaults = z.object({
  acceptSeconds: z.number().int().min(10, 'Between 10 and 120 seconds.').max(120, 'Between 10 and 120 seconds.').optional(),
  ifNobodyAccepts: z.enum(['next_nearest', 'next_in_rule', 'platform']).optional(),
  nightHandover: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.').optional(),
});
const Test = z.object({ postcode: z.string().trim().min(3, 'Enter a postcode.').max(12), type: z.string().min(2).max(40) });
const AssetQ = LocationQuery.extend({ tab: z.enum(['all', 'traffic_light', 'street_light', 'camera', 'faults', 'overdue']).optional() });
const Asset = z.object({
  kind: z.enum(Object.keys(ASSET_KIND) as [AssetKind, ...AssetKind[]]),
  name: z.string().trim().min(2, 'Give it a name, like "Junction 12, Ring Rd".').max(120),
  postcode: z.string().trim().max(12).optional(),
  controller: z.string().trim().max(80).optional(),
  nextServiceOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const Import = z.object({ csv: z.string().min(3, 'Paste the list.').max(200_000) });
const Order = z.object({ kind: z.enum(['repair', 'service', 'inspection', 'replace']), note: z.string().trim().max(500).optional() });
const Action = z.object({ action: z.enum(['restart', 'flashing_amber', 'manual_control']) });
const Decide = z.object({ approve: z.boolean() });
const Settings = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  kind: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email('Enter an email address.').max(120).optional(),
  alerts: z.record(z.boolean()).optional(),
  safetyPlanSigned: z.boolean().optional(),
});
const Team = z.object({ name: z.string().trim().max(120).optional(), phone: Phone, role: z.enum(AGENCY_TEAM_ROLES), stationId: z.string().uuid().optional() });
const StationEdit = z.object({ name: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(20).optional(), status: z.enum(['active', 'paused']).optional() });
const Audience = LocationQuery.extend({ who: z.array(z.enum(['citizen', 'officer', 'head', 'agency_admin'])).max(4), kind: z.enum(['marketing', 'safety']).optional(), channels: z.array(z.enum(['push', 'sms', 'whatsapp'])).optional() });
const Compose = z.object({
  action: z.enum(['draft', 'request_approval', 'schedule', 'send', 'test']),
  title: z.string().trim().min(1, 'Add a title.').max(120),
  body: z.string().trim().min(1, 'Write a message.').max(1000),
  kind: z.enum(['marketing', 'safety']),
  urgent: z.boolean().optional(),
  audience: LocationQuery.extend({ who: z.array(z.enum(['citizen', 'officer', 'head', 'agency_admin'])).max(4) }),
  channels: z.array(z.enum(['push', 'sms', 'whatsapp'])).min(1, 'Choose how it is sent.'),
  languages: z.array(z.enum(['en', 'pcm', 'yo', 'ha', 'ig'])).max(5).optional(),
  link: z.string().trim().max(200).optional(),
  sendAt: z.string().datetime({ offset: true }).optional(),
});

const csv = (res: Response, name: string, body: string) => res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' }).send(body);

/** Agency boards. Every route checks the role matrix for this agency (see PERMISSIONS). */
@Controller('agencies/:id')
export class AgencyOpsController {
  constructor(
    @Inject(AgencyOpsService) private readonly ops: AgencyOpsService,
    @Inject(AdminOversightService) private readonly crm: AdminOversightService,
  ) {}

  @Get('officers')
  officers(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(LocationQuery)) f: z.infer<typeof LocationQuery>) {
    return this.ops.officers(p, id, f);
  }

  @Post('officers/invite')
  invite(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Invite)) b: z.infer<typeof Invite>) {
    return this.ops.inviteOfficer(p, id, b);
  }

  @Get('equipment')
  equipment(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(LocationQuery)) f: z.infer<typeof LocationQuery>) {
    return this.ops.equipment(p, id, f);
  }

  @Post('equipment')
  addEquipment(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Equip)) b: z.infer<typeof Equip>) {
    return this.ops.addEquipment(p, id, b);
  }

  @Patch('equipment/:itemId')
  patchEquipment(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body(new ZodPipe(EquipPatch)) b: z.infer<typeof EquipPatch>) {
    return this.ops.updateEquipment(p, id, itemId, b);
  }

  @Get('routing')
  routing(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.routing(p, id);
  }

  @Post('routing/rules')
  addRule(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Rule)) b: z.infer<typeof Rule>) {
    return this.ops.saveRule(p, id, b);
  }

  @Put('routing/rules/:ruleId')
  editRule(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('ruleId', ParseUUIDPipe) ruleId: string, @Body(new ZodPipe(Rule)) b: z.infer<typeof Rule>) {
    return this.ops.saveRule(p, id, { ...b, id: ruleId });
  }

  @Put('routing/defaults')
  defaults(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Defaults)) b: z.infer<typeof Defaults>) {
    return this.ops.saveDefaults(p, id, b);
  }

  @Post('routing/test')
  test(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Test)) b: z.infer<typeof Test>) {
    return this.ops.testRoute(p, id, b);
  }

  @Get('billing')
  billing(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.billingSummary(p, id);
  }

  @Get('invoices.csv')
  async invoicesCsv(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    csv(res, 'invoices.csv', await this.ops.invoicesCsv(p, id));
  }

  @Get('assets')
  assets(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(AssetQ)) q: z.infer<typeof AssetQ>) {
    return this.ops.assets(p, id, q);
  }

  @Post('assets')
  addAsset(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Asset)) b: z.infer<typeof Asset>) {
    return this.ops.addAsset(p, id, b);
  }

  @Post('assets/import')
  importAssets(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Import)) b: z.infer<typeof Import>) {
    return this.ops.importAssets(p, id, b.csv);
  }

  @Get('assets/:assetId')
  asset(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('assetId', ParseUUIDPipe) assetId: string) {
    return this.ops.asset(p, id, assetId);
  }

  @Post('assets/:assetId/work-orders')
  workOrder(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('assetId', ParseUUIDPipe) assetId: string, @Body(new ZodPipe(Order)) b: z.infer<typeof Order>) {
    return this.ops.workOrder(p, id, assetId, b);
  }

  @Post('assets/:assetId/actions')
  action(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('assetId', ParseUUIDPipe) assetId: string, @Body(new ZodPipe(Action)) b: z.infer<typeof Action>) {
    return this.ops.requestAction(p, id, assetId, b.action);
  }

  @Post('asset-actions/:actionId')
  decide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('actionId', ParseUUIDPipe) actionId: string, @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>) {
    return this.ops.approveAction(p, id, actionId, b.approve);
  }

  @Get('settings')
  settings(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.settings(p, id);
  }

  @Patch('settings')
  saveSettings(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Settings)) b: z.infer<typeof Settings>) {
    return this.ops.saveSettings(p, id, b);
  }

  @Post('team')
  team(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Team)) b: z.infer<typeof Team>) {
    return this.ops.inviteTeam(p, id, b);
  }

  @Delete('team/:userId/:role')
  removeTeam(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Param('role') role: string) {
    return this.ops.removeTeam(p, id, userId, role);
  }

  @Get('access-log.csv')
  async accessLog(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    csv(res, 'access-log.csv', await this.ops.accessLogCsv(p, id));
  }

  @Get('stations/:stationId/detail')
  station(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('stationId', ParseUUIDPipe) sid: string) {
    return this.ops.stationDetail(p, id, sid);
  }

  @Patch('stations/:stationId/profile')
  editStation(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('stationId', ParseUUIDPipe) sid: string, @Body(new ZodPipe(StationEdit)) b: z.infer<typeof StationEdit>) {
    return this.ops.editStation(p, id, sid, b);
  }

  // Messaging: the same campaigns as the platform's, limited to this agency's people and area.
  @Post('crm/audience')
  audience(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Audience)) b: z.infer<typeof Audience>) {
    return this.crm.audienceSize(p, b, { agencyId: id });
  }

  @Post('crm/campaigns')
  compose(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Compose)) b: z.infer<typeof Compose>) {
    return this.crm.compose(p, b, { agencyId: id });
  }

  @Get('crm/campaigns')
  campaigns(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.crm.campaigns(p, { agencyId: id });
  }

  @Get('crm/campaigns/:cid')
  campaign(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('cid', ParseUUIDPipe) cid: string) {
    return this.crm.campaign(p, cid, { agencyId: id });
  }

  @Get('crm/campaigns/:cid/results.csv')
  async results(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('cid', ParseUUIDPipe) cid: string, @Res() res: Response) {
    csv(res, 'campaign-results.csv', await this.crm.resultsCsv(p, cid, { agencyId: id }));
  }

  @Post('crm/campaigns/:cid/approve')
  approve(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('cid', ParseUUIDPipe) cid: string) {
    return this.crm.approve(p, cid, { agencyId: id });
  }

  @Post('crm/campaigns/:cid/resend')
  resend(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('cid', ParseUUIDPipe) cid: string) {
    return this.crm.resend(p, cid, { agencyId: id });
  }

  @Post('crm/campaigns/:cid/duplicate')
  duplicate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('cid', ParseUUIDPipe) cid: string) {
    return this.crm.duplicate(p, cid, { agencyId: id });
  }
}
