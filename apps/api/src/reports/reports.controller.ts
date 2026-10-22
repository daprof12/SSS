import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { DateRangeQuery, type DateRange } from '../core/date-range';
import { ZodPipe } from '../core/http';
import { IssuesService } from './issues.service';
import { TipsService } from './tips.service';

const Where = {
  postcode: z.string().trim().min(3).max(12).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
};
const TipBody = z.object({
  category: z.string().min(1).max(40),
  description: z.string().max(1000, 'Keep it under 1000 characters.'),
  anonymous: z.boolean().default(true),
  clientRef: z.string().min(8).max(80),
  ...Where,
});
const TextBody = z.object({ text: z.string().trim().min(3, 'Write a little more.').max(1000) });
const IssueBody = z.object({
  category: z.string().min(1).max(40),
  subtype: z.string().max(60).optional(),
  severity: z.enum(['small', 'dangerous', 'blocking']),
  description: z.string().max(1000).optional(),
  anonymous: z.boolean().default(false),
  clientRef: z.string().min(8).max(80),
  /** The citizen picked photos; they upload right after the case is created, so words are optional. */
  withMedia: z.boolean().default(false),
  ...Where,
});
const NearbyQuery = z.object({
  category: z.string(),
  postcode: z.string().optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
});
const VoteBody = z.object({ vote: z.enum(['yes', 'no']) });
const TipTab = z.enum(['all', 'waiting', 'paid', 'declined']).default('all');

const TipAct = z.object({
  event: z.enum(['ask_more', 'outcome_recorded', 'approve', 'decline', 'close', 'mark_false']),
  comment: z.string().max(1000).optional(),
  outcome: z.string().max(40).optional(),
  severity: z.enum(['standard', 'high']).optional(),
  amountKobo: z.number().int().positive().optional(),
  /** Value recovered or seized, for "% of seized value" rates. */
  recoveredKobo: z.number().int().positive().optional(),
  reason: z.string().max(1000).optional(),
});
const IssueAct = z.object({
  event: z.enum(['assign', 'start', 'mark_fixed']),
  targetOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(1000).optional(),
});
const AgencyTipTab = z.enum(['new', 'claims', 'closed']).default('new');

@Controller()
export class ReportsController {
  constructor(
    @Inject(TipsService) private readonly tips: TipsService,
    @Inject(IssuesService) private readonly issues: IssuesService,
  ) {}

  // ---------- tips (citizens and officers)
  @Get('tips/categories')
  tipCategories() {
    return this.tips.categories();
  }

  @Post('tips')
  sendTip(@CurrentUser() p: Principal, @Body(new ZodPipe(TipBody)) b: z.infer<typeof TipBody>) {
    return this.tips.create(p, b);
  }

  @Get('me/tips')
  myTips(@CurrentUser() p: Principal, @Query('tab', new ZodPipe(TipTab)) tab: z.infer<typeof TipTab>) {
    return this.tips.mine(p, tab);
  }

  @Get('tips/:id')
  tip(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.tips.detail(p, id);
  }

  @Post('tips/:id/info')
  tipInfo(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>) {
    return this.tips.addInfo(p, id, b.text);
  }

  @Post('tips/:id/withdraw')
  withdraw(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.tips.withdraw(p, id);
  }

  // ---------- public issues
  @Get('issues/categories')
  issueCategories() {
    return this.issues.categories();
  }

  @Get('issues/nearby')
  nearby(@Query(new ZodPipe(NearbyQuery)) q: z.infer<typeof NearbyQuery>) {
    return this.issues.nearby(q.category, q);
  }

  @Post('issues')
  report(@CurrentUser() p: Principal, @Body(new ZodPipe(IssueBody)) b: z.infer<typeof IssueBody>) {
    return this.issues.create(p, b);
  }

  @Get('me/issues')
  myIssues(@CurrentUser() p: Principal) {
    return this.issues.mine(p);
  }

  @Get('issues/:id')
  issue(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.issues.detail(p, id);
  }

  @Post('issues/:id/vote')
  vote(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VoteBody)) b: z.infer<typeof VoteBody>) {
    return this.issues.vote(p, id, b.vote);
  }

  // ---------- agency side
  @Get('agencies/:agencyId/tips')
  agencyTips(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query('tab', new ZodPipe(AgencyTipTab)) tab: z.infer<typeof AgencyTipTab>, @Query(new ZodPipe(DateRangeQuery)) r: DateRange) {
    return this.tips.queue(p, a, tab, r);
  }

  @Get('agencies/:agencyId/tips/:tipId')
  agencyTip(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('tipId', ParseUUIDPipe) t: string) {
    return this.tips.agencyDetail(p, a, t);
  }

  @Post('agencies/:agencyId/tips/:tipId/actions')
  tipAct(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('tipId', ParseUUIDPipe) t: string, @Body(new ZodPipe(TipAct)) b: z.infer<typeof TipAct>) {
    return this.tips.act(p, a, t, b);
  }

  @Get('agencies/:agencyId/issues')
  agencyIssues(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query(new ZodPipe(DateRangeQuery)) r: DateRange) {
    return this.issues.queue(p, a, r);
  }

  @Get('agencies/:agencyId/issues/:caseId')
  agencyIssue(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string) {
    return this.issues.agencyDetail(p, a, k);
  }

  @Post('agencies/:agencyId/issues/:caseId/actions')
  issueAct(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string, @Body(new ZodPipe(IssueAct)) b: z.infer<typeof IssueAct>) {
    return this.issues.act(p, a, k, b);
  }
}
