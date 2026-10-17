import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { agencyDirectory, agencyStates, type AgencyKind } from '@erp/domain';
import { CurrentUser, type Principal } from '../core/auth';
import { AppError, ZodPipe } from '../core/http';
import { PayoutsService } from './payouts.service';
import { AgenciesService } from './agencies.service';
import { AgencyBillingService } from './billing.service';

const Kinds = agencyDirectory.map((a) => a.kind) as [AgencyKind, ...AgencyKind[]];
const RegisterBody = z
  .object({
    kind: z.enum(Kinds),
    otherName: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().min(2).max(200),
    regNo: z.string().trim().min(2).max(60),
    headOfficePostcode: z.string().trim().min(3).max(12).transform((s) => s.replace(/\s+/g, '').toUpperCase()),
    unitType: z.string().trim().min(2).max(60),
    officialEmail: z.string().trim().email('Enter a valid email address.'),
    signatoryName: z.string().trim().min(2).max(120),
    tin: z.string().trim().regex(/^\d{8}-?\d{4}$/, 'Enter the TIN as on your certificate.').optional(),
  })
  .refine((b) => b.kind !== 'other' || b.otherName, { message: 'Enter the agency name.', path: ['otherName'] });

const DocumentBody = z.object({
  kind: z.enum(['establishment_proof', 'authorisation_letter', 'head_id', 'signatory_letter', 'registration_certificate']),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png'], { message: 'Upload a PDF, JPG or PNG.' }),
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024, 'Files can be up to 20 MB.'),
});

const Addons = z.record(z.string(), z.number().int().min(0).max(500)).default({});
const PlanBody = z.object({ addons: Addons });
const ChangePlanBody = z.object({ addons: Addons, confirm: z.boolean().default(false) });
const PayBody = z.object({ method: z.enum(['card', 'bank_transfer', 'ussd']) });
const PoBody = z.object({ poNumber: z.string().trim().min(2, 'Enter your PO number.').max(60) });
const StationBody = z.object({
  name: z.string().trim().min(2).max(120),
  postcode: z.string().trim().min(3).max(12).transform((s) => s.replace(/\s+/g, '').toUpperCase()),
  headUserId: z.string().uuid().optional(),
  phone: z.string().regex(/^\+234\d{10}$/, 'Enter a Nigerian phone number.').optional(),
});
const HeadBody = z.object({ headUserId: z.string().uuid() });
const AreasBody = z.object({ areas: z.array(z.object({ level: z.enum(['district', 'area']), areaId: z.string().trim().min(2).max(40) })).min(1, 'Choose at least one area.') });
const OfficerBody = z.object({ userId: z.string().uuid(), badgeNo: z.string().trim().min(2).max(30), rank: z.string().trim().max(40).optional() });
const PayoutBody = z.object({
  bankCode: z.string().trim().min(3).max(10),
  bankName: z.string().trim().min(2).max(80),
  accountNumber: z.string().regex(/^\d{10}$/, 'Enter the 10-digit account number.'),
  accountName: z.string().trim().min(2).max(120),
});
const InventoryBody = z.object({ feeCode: z.string().trim(), quantity: z.number().int().min(1).max(1000), stationId: z.string().uuid().optional() });
const OffboardBody = z.object({ reason: z.string().trim().min(3, 'Tell us why you are leaving.').max(500) });

@Controller()
export class AgenciesController {
  constructor(
    @Inject(AgenciesService) private readonly agencies: AgenciesService,
    @Inject(AgencyBillingService) private readonly billing: AgencyBillingService,
  ) {}

  /** Stage 1. The agency list for the form. */
  @Get('agencies/directory')
  directory() {
    return agencyDirectory;
  }

  @Post('agencies/register')
  register(@CurrentUser() p: Principal, @Body(new ZodPipe(RegisterBody)) b: z.infer<typeof RegisterBody>) {
    return this.agencies.register(p, b);
  }

  @Get('me/agencies')
  mine(@CurrentUser() p: Principal) {
    return this.agencies.mine(p);
  }

  @Get('agencies/:id')
  status(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.status(p, id);
  }

  // Stage 2–3
  @Post('agencies/:id/documents')
  addDocument(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DocumentBody)) b: z.infer<typeof DocumentBody>) {
    return this.agencies.addDocument(p, id, b);
  }

  @Post('agencies/:id/submit')
  submit(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.submit(p, id);
  }

  // Stage 4
  @Get('agencies/:id/plans')
  plans(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.planCards(p, id);
  }

  @Post('agencies/:id/plan')
  choosePlan(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PlanBody)) b: z.infer<typeof PlanBody>) {
    return this.billing.choosePlan(p, id, b.addons);
  }

  // Stage 10
  @Post('agencies/:id/plan/change')
  changePlan(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ChangePlanBody)) b: z.infer<typeof ChangePlanBody>) {
    return this.billing.changePlan(p, id, b.addons, b.confirm);
  }

  // Stage 5 and 8: invoices
  @Get('agencies/:id/invoices')
  invoices(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.listInvoices(p, id);
  }

  @Get('agencies/:id/invoices/:invoiceId')
  invoice(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('invoiceId', ParseUUIDPipe) invoiceId: string) {
    return this.billing.invoice(p, id, invoiceId);
  }

  @Post('agencies/:id/invoices/:invoiceId/pay')
  pay(
    @CurrentUser() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(PayBody)) b: z.infer<typeof PayBody>,
  ) {
    if (!key || key.length < 8) throw new AppError(400, 'idempotency_key_required', 'Try again.');
    return this.billing.payWithPaystack(p, id, invoiceId, b.method, key);
  }

  @Post('agencies/:id/invoices/:invoiceId/pay-by-invoice')
  payByInvoice(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body(new ZodPipe(PoBody)) b: z.infer<typeof PoBody>) {
    return this.billing.payByInvoice(p, id, invoiceId, b.poNumber);
  }

  // Stage 6: the one setup checklist and the steps behind it
  @Get('agencies/:id/setup')
  setup(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.checklist(p, id);
  }

  @Post('agencies/:id/stations')
  addStation(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(StationBody)) b: z.infer<typeof StationBody>) {
    return this.agencies.addStation(p, id, b);
  }

  @Patch('agencies/:id/stations/:stationId')
  setHead(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('stationId', ParseUUIDPipe) sid: string, @Body(new ZodPipe(HeadBody)) b: z.infer<typeof HeadBody>) {
    return this.agencies.setHead(p, id, sid, b.headUserId);
  }

  @Put('agencies/:id/stations/:stationId/areas')
  setAreas(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('stationId', ParseUUIDPipe) sid: string, @Body(new ZodPipe(AreasBody)) b: z.infer<typeof AreasBody>) {
    return this.agencies.setAreas(p, id, sid, b.areas);
  }

  @Post('agencies/:id/stations/:stationId/officers')
  addOfficer(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('stationId', ParseUUIDPipe) sid: string, @Body(new ZodPipe(OfficerBody)) b: z.infer<typeof OfficerBody>) {
    return this.agencies.addOfficer(p, id, sid, b);
  }

  @Post('agencies/:id/payout-account')
  payoutAccount(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PayoutBody)) b: z.infer<typeof PayoutBody>) {
    return this.agencies.linkPayoutAccount(p, id, b);
  }

  @Post('agencies/:id/inventory')
  addInventory(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(InventoryBody)) b: z.infer<typeof InventoryBody>) {
    return this.agencies.addInventory(p, id, b);
  }

  // Stage 7
  @Post('agencies/:id/go-live')
  goLive(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.goLive(p, id);
  }

  // Stage 11
  @Get('agencies/:id/offboard')
  offboardStatus(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.offboardStatus(p, id);
  }

  @Post('agencies/:id/offboard')
  offboard(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(OffboardBody)) b: z.infer<typeof OffboardBody>) {
    return this.agencies.requestOffboard(p, id, b.reason);
  }
}

// ---------------------------------------------------------------- platform admin

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const DecisionBody = z
  .object({
    decision: z.enum(['approve', 'ask_more', 'reject']),
    comment: z.string().trim().max(1000).optional(),
    reason: z.string().trim().max(1000).optional(),
    documents: z.array(z.object({ id: z.string().uuid(), status: z.enum(['accepted', 'rejected']), note: z.string().trim().max(500).optional() })).optional(),
  })
  .refine((b) => b.decision !== 'ask_more' || (b.comment && b.comment.length >= 3), { message: 'Tell the agency what to add or change.', path: ['comment'] })
  .refine((b) => b.decision !== 'reject' || (b.reason && b.reason.length >= 3), { message: 'A reason is required. It is shown to the agency.', path: ['reason'] });
const MarkPaidBody = z.object({
  amountKobo: z.number().int().positive(),
  bankReference: z.string().trim().min(4).max(80),
  receivedOn: Day.optional(),
  note: z.string().trim().max(500).optional(),
});
const WaiveBody = z.object({ reason: z.string().trim().min(3, 'A reason is required.').max(500) });
const AsOfBody = z.object({ asOf: Day });
const OverrideBody = z.object({ amountKobo: z.number().int().min(0), reason: z.string().trim().min(3, 'A reason is required.').max(500) });
const StatusQuery = z.enum(agencyStates).optional();
const InvoiceStateQuery = z.enum(['draft', 'issued', 'paid', 'overdue', 'waived', 'credited']).optional();

@Controller('admin')
export class AdminAgenciesController {
  constructor(
    @Inject(AgenciesService) private readonly agencies: AgenciesService,
    @Inject(AgencyBillingService) private readonly billing: AgencyBillingService,
    @Inject(PayoutsService) private readonly payoutsSvc: PayoutsService,
  ) {}

  /** Agencies → Waiting (default) or any status. */
  @Get('agencies')
  list(@CurrentUser() p: Principal, @Query('status', new ZodPipe(StatusQuery)) status?: string) {
    return this.agencies.adminList(p, status);
  }

  @Get('agencies/:id')
  card(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.adminCard(p, id);
  }

  @Post('agencies/:id/decision')
  decide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>) {
    return this.agencies.decide(p, id, b);
  }

  @Put('agencies/:id/prices/:code')
  override(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Body(new ZodPipe(OverrideBody)) b: z.infer<typeof OverrideBody>) {
    return this.billing.setPriceOverride(p, id, code, b.amountKobo, b.reason);
  }

  @Post('agencies/:id/offboard/approve')
  completeOffboard(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.agencies.completeOffboard(p, id);
  }

  /** Dunning list: open invoices across agencies, overdue first. */
  @Get('invoices')
  invoices(@CurrentUser() p: Principal, @Query('state', new ZodPipe(InvoiceStateQuery)) state?: z.infer<typeof InvoiceStateQuery>) {
    return this.billing.dunning(p, state);
  }

  @Post('invoices/:id/mark-paid')
  markPaid(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MarkPaidBody)) b: z.infer<typeof MarkPaidBody>) {
    return this.billing.markTransferReceived(p, id, b);
  }

  @Post('invoices/:id/waive')
  waive(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(WaiveBody)) b: z.infer<typeof WaiveBody>) {
    return this.billing.waive(p, id, b.reason);
  }

  @Post('payouts/:id/approve')
  approvePayout(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.approvePayout(p, id);
  }

  @Get('payouts')
  payouts(@CurrentUser() p: Principal, @Query('state') state?: string) {
    return this.payoutsSvc.list(p, state);
  }

  @Post('payouts/:id/retry')
  retryPayout(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.payoutsSvc.retry(p, id);
  }

  /** Scheduled jobs, callable by staff (and by the scheduler) with an explicit day. */
  @Post('billing/generate-invoices')
  generate(@CurrentUser() p: Principal, @Body(new ZodPipe(AsOfBody)) b: z.infer<typeof AsOfBody>) {
    return this.billing.generateMonthly(p, b.asOf);
  }

  @Post('billing/mark-overdue')
  overdue(@CurrentUser() p: Principal, @Body(new ZodPipe(AsOfBody)) b: z.infer<typeof AsOfBody>) {
    return this.billing.sweepOverdue(p, b.asOf);
  }
}
