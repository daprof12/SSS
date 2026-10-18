import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { BountiesService } from './bounties.service';

const naira = z.number().int().positive('Enter an amount.');
const RateBody = z.object({
  basis: z.enum(['fixed', 'tiered', 'percent_capped']),
  standardKobo: naira.optional(),
  percent: z.number().positive().max(50, 'Enter a share between 0.1% and 50%.').optional(),
  seriousKobo: naira.optional(),
  capKobo: naira.nullable().optional(),
  active: z.boolean().default(true),
});
const bps = z.number().int().min(0, 'Enter a fee between 0% and 50%.').max(5000, 'Enter a fee between 0% and 50%.');
const FeeBody = z.object({ bps: bps.nullable() });
const FeeSettingsBody = z.object({ suggestedBps: bps, minBps: bps, maxBps: bps });
const FundBody = z.object({
  amountKobo: z.number().int().positive('Enter an amount.'),
  method: z.enum(['card', 'bank_transfer', 'ussd']),
  idempotencyKey: z.string().min(8).max(80),
});

@Controller('agencies/:agencyId')
export class BountiesController {
  constructor(@Inject(BountiesService) private readonly bounties: BountiesService) {}

  @Get('bounties/summary')
  summary(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.bounties.summary(p, a);
  }

  @Put('bounty-rates/:category')
  setRate(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('category') category: string, @Body(new ZodPipe(RateBody)) b: z.infer<typeof RateBody>) {
    return this.bounties.setRate(p, a, category, b);
  }

  @Put('bounty-fee')
  setFee(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Body(new ZodPipe(FeeBody)) b: z.infer<typeof FeeBody>) {
    return this.bounties.setFee(p, a, b.bps);
  }

  @Post('bounty-pool/fund')
  fund(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Body(new ZodPipe(FundBody)) b: z.infer<typeof FundBody>) {
    return this.bounties.fund(p, a, b);
  }

  @Get('bounty-pool/payments/:reference')
  status(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('reference') ref: string) {
    return this.bounties.fundStatus(p, a, ref);
  }
}

/** Platform admin: the platform fee on bounties (suggestion and allowed range). */
@Controller('admin/settings')
export class AdminBountyFeeController {
  constructor(@Inject(BountiesService) private readonly bounties: BountiesService) {}

  @Get('bounty-fee')
  get(@CurrentUser() p: Principal) {
    return this.bounties.getFeeSettings(p);
  }

  @Put('bounty-fee')
  set(@CurrentUser() p: Principal, @Body(new ZodPipe(FeeSettingsBody)) b: z.infer<typeof FeeSettingsBody>) {
    return this.bounties.setFeeSettings(p, b);
  }
}
