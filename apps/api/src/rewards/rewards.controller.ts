import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { RewardsService } from './rewards.service';

const RuleBody = z.object({
  fiveStarKobo: z.number().int().min(0),
  fourStarPct: z.number().int().min(0).max(100),
  split: z.enum(['equal', 'lead_first']),
  active: z.boolean(),
});
const SharesBody = z.object({ officerPct: z.number().min(0).max(100), stationPct: z.number().min(0).max(100), agencyPct: z.number().min(0).max(100) });

@Controller('agencies/:agencyId')
export class RewardsController {
  constructor(@Inject(RewardsService) private readonly rewards: RewardsService) {}

  @Get('rewards')
  summary(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.rewards.summary(p, a);
  }

  @Put('reward-rule')
  rule(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Body(new ZodPipe(RuleBody)) b: z.infer<typeof RuleBody>) {
    return this.rewards.setRule(p, a, b);
  }

  @Put('donation-shares')
  shares(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Body(new ZodPipe(SharesBody)) b: z.infer<typeof SharesBody>) {
    return this.rewards.setDonationShares(p, a, b);
  }
}
