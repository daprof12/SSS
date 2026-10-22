import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { DateFields, DateRangeQuery, type DateRange } from '../core/date-range';
import { ZodPipe } from '../core/http';
import { RewardsService } from './rewards.service';

const RuleBody = z.object({
  fiveStarKobo: z.number().int().min(0),
  fourStarPct: z.number().int().min(0).max(100),
  split: z.enum(['equal', 'lead_first']),
  active: z.boolean(),
});
const DonationsQ = z.object({ ...DateFields, level: z.enum(['agency', 'station', 'officer']).optional() });
const SharesBody = z.object({ officerPct: z.number().min(0).max(100), stationPct: z.number().min(0).max(100), agencyPct: z.number().min(0).max(100) });

@Controller('agencies/:agencyId')
export class RewardsController {
  constructor(@Inject(RewardsService) private readonly rewards: RewardsService) {}

  @Get('rewards')
  summary(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.rewards.summary(p, a);
  }

  /** Gifts to the agency, its stations and its officers, newest first. */
  @Get('donations')
  donations(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query(new ZodPipe(DonationsQ)) q: z.infer<typeof DonationsQ>) {
    return this.rewards.donations(p, a, q);
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

const StationDonationsQ = z.object({ ...DateFields, level: z.enum(['station', 'officer']).optional() });

/** Station head: what this station's officers earned in rewards, and the gifts to the station and its officers. Read only. */
@Controller('me/station')
export class StationMoneyController {
  constructor(@Inject(RewardsService) private readonly rewards: RewardsService) {}

  @Get('payouts')
  payouts(@CurrentUser() p: Principal, @Query(new ZodPipe(DateRangeQuery)) q: DateRange) {
    return this.rewards.stationPayouts(p, q);
  }

  @Get('donations')
  donations(@CurrentUser() p: Principal, @Query(new ZodPipe(StationDonationsQ)) q: z.infer<typeof StationDonationsQ>) {
    return this.rewards.stationDonations(p, q);
  }
}
