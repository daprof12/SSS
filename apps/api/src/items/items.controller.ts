import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { DateFields } from '../core/date-range';
import { ZodPipe } from '../core/http';
import { LocationQuery } from '../core/location-filter';
import { ItemsService } from './items.service';

const Where = {
  postcode: z.string().trim().min(3).max(12).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
};
const Code = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Use lower-case letters, digits and _ (e.g. motorbike).');
const Text = (max: number) => z.string().trim().max(max).optional();

const ItemBody = z.object({
  typeCode: Code,
  identifier: z.string().max(80),
  make: Text(60),
  model: Text(60),
  colour: Text(40),
  description: Text(500),
});
const StolenBody = z
  .object({
    itemId: z.string().uuid().optional(),
    item: ItemBody.optional(),
    stolenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the day it was stolen.'),
    circumstances: Text(1000),
    policeReportNo: Text(40),
    clientRef: z.string().min(8).max(80),
    ...Where,
  })
  .refine((b) => !!b.itemId !== !!b.item, { message: 'Choose the item that was stolen.', path: ['itemId'] });
const WithdrawBody = z.object({ reason: z.enum(['found', 'mistake']) });
const CheckBody = z.object({
  typeCode: Code,
  identifier: z.string().max(80),
  context: z.enum(['buying', 'repairing', 'found', 'other']).default('buying'),
  accuracy: z.number().int().min(0).max(100000).optional(),
  ...Where,
});
const CheckDetails = z.object({
  sellerName: Text(80),
  sellerPhone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a phone number like 0803 000 0000.').optional().or(z.literal('')),
  note: Text(1000),
});
const Rule = z.object({
  minLength: z.number().int().min(3).max(64),
  maxLength: z.number().int().min(3).max(64),
  charset: z.enum(['digits', 'alnum', 'vin']),
  checksum: z.enum(['none', 'luhn', 'vin']),
  pattern: z.string().max(200).nullish(),
});
const Doc = z.object({ code: Code, label: z.string().trim().min(2).max(80), required: z.boolean() });
const TypeBody = z.object({
  label: z.string().trim().min(2, 'Name the item type.').max(40),
  icon: z.string().regex(/^[a-z_]{2,20}$/).default('other'),
  identifierLabel: z.string().trim().min(2, 'Name its unique identifier (e.g. Frame number).').max(40),
  identifierHint: z.string().trim().max(200).default(''),
  rule: Rule,
  documents: z.array(Doc).max(6),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(1000).default(100),
});
const NewTypeBody = TypeBody.extend({ code: Code });

const CaseTab = z.enum(['open', 'closed', 'all']).default('open');
const MatchTab = z.enum(['new', 'reviewed', 'all']).default('new');
const QueueQuery = LocationQuery.extend({ ...DateFields, tab: CaseTab, type: Code.optional() });
const MatchQuery = LocationQuery.extend({ ...DateFields, tab: MatchTab });
const Act = z.object({ event: z.enum(['investigate', 'locate', 'recover', 'return_to_owner', 'close']), note: Text(1000) });
const Review = z.object({ outcome: z.enum(['followed_up', 'dismissed']), note: Text(1000) });

const range = (q: { from?: string; to?: string }) => ({ from: q.from, to: q.to });

@Controller()
export class ItemsController {
  constructor(@Inject(ItemsService) private readonly items: ItemsService) {}

  // ---------- item types
  @Get('item-types')
  types() {
    return this.items.types();
  }

  @Get('admin/item-types')
  adminTypes(@CurrentUser() p: Principal) {
    return this.items.adminTypes(p);
  }

  @Post('admin/item-types')
  createType(@CurrentUser() p: Principal, @Body(new ZodPipe(NewTypeBody)) b: z.infer<typeof NewTypeBody>) {
    return this.items.createType(p, b);
  }

  @Put('admin/item-types/:code')
  updateType(@CurrentUser() p: Principal, @Param('code', new ZodPipe(Code)) code: string, @Body(new ZodPipe(TypeBody)) b: z.infer<typeof TypeBody>) {
    return this.items.updateType(p, code, b);
  }

  // ---------- my items
  @Get('me/items')
  mine(@CurrentUser() p: Principal) {
    return this.items.mine(p);
  }

  @Post('me/items')
  register(@CurrentUser() p: Principal, @Body(new ZodPipe(ItemBody)) b: z.infer<typeof ItemBody>) {
    return this.items.register(p, b);
  }

  @Get('me/items/:id')
  item(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.items.item(p, id);
  }

  @Delete('me/items/:id')
  remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.items.remove(p, id);
  }

  // ---------- stolen reports
  @Post('stolen-reports')
  report(@CurrentUser() p: Principal, @Body(new ZodPipe(StolenBody)) b: z.infer<typeof StolenBody>) {
    return this.items.reportStolen(p, b);
  }

  @Get('me/stolen-reports')
  myReports(@CurrentUser() p: Principal) {
    return this.items.myCases(p);
  }

  @Get('stolen-reports/:id')
  stolen(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.items.caseDetail(p, id);
  }

  @Post('stolen-reports/:id/withdraw')
  withdraw(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(WithdrawBody)) b: z.infer<typeof WithdrawBody>) {
    return this.items.withdraw(p, id, b.reason);
  }

  // ---------- check before you buy
  @Post('item-checks')
  check(@CurrentUser() p: Principal, @Body(new ZodPipe(CheckBody)) b: z.infer<typeof CheckBody>, @Req() req: Request) {
    return this.items.check(p, b, { ip: (req.ip ?? '').replace(/^::ffff:/, '') || undefined, userAgent: String(req.headers['user-agent'] ?? '') });
  }

  @Get('me/item-checks')
  myChecks(@CurrentUser() p: Principal) {
    return this.items.myChecks(p);
  }

  @Post('item-checks/:id/details')
  checkDetails(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CheckDetails)) b: z.infer<typeof CheckDetails>) {
    return this.items.checkDetails(p, id, { ...b, sellerPhone: b.sellerPhone || undefined });
  }

  // ---------- police
  @Get('agencies/:agencyId/stolen')
  queue(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query(new ZodPipe(QueueQuery)) q: z.infer<typeof QueueQuery>) {
    return this.items.queue(p, a, q.tab, q, range(q), q.type);
  }

  @Get('agencies/:agencyId/stolen-matches')
  matches(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query(new ZodPipe(MatchQuery)) q: z.infer<typeof MatchQuery>) {
    return this.items.matches(p, a, q.tab, q, range(q));
  }

  @Get('agencies/:agencyId/stolen/:caseId')
  agencyCase(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string) {
    return this.items.agencyDetail(p, a, k);
  }

  @Post('agencies/:agencyId/stolen/:caseId/actions')
  act(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string, @Body(new ZodPipe(Act)) b: z.infer<typeof Act>) {
    return this.items.act(p, a, k, b);
  }

  @Post('agencies/:agencyId/stolen/:caseId/matches/:checkId/review')
  review(
    @CurrentUser() p: Principal,
    @Param('agencyId', ParseUUIDPipe) a: string,
    @Param('caseId', ParseUUIDPipe) k: string,
    @Param('checkId', ParseUUIDPipe) c: string,
    @Body(new ZodPipe(Review)) b: z.infer<typeof Review>,
  ) {
    return this.items.reviewMatch(p, a, k, c, b);
  }
}
