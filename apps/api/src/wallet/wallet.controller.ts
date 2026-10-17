import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type Principal } from '../core/auth';
import { AppError, ZodPipe } from '../core/http';
import { WalletService } from './wallet.service';

const FundBody = z.object({
  amountKobo: z.number().int().positive(),
  method: z.enum(['card', 'bank_transfer', 'ussd']),
});
const Tab = z.enum(['all', 'money_in', 'money_out', 'rewards', 'bounties', 'payments', 'withdrawals']).default('all');

@Controller()
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallet: WalletService) {}

  @Get('me/wallet')
  summary(@CurrentUser() p: Principal, @Query('tab', new ZodPipe(Tab)) tab: z.infer<typeof Tab>) {
    return this.wallet.summary(p.userId, tab);
  }

  @Post('me/wallet/fund')
  fund(
    @CurrentUser() p: Principal,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(FundBody)) b: z.infer<typeof FundBody>,
  ) {
    // Double-tap protection (UX Gap §9): one key, one charge.
    if (!key || key.length < 8) throw new AppError(400, 'idempotency_key_required', 'Try again.');
    return this.wallet.startFunding(p, b.amountKobo, b.method, key);
  }

  @Get('me/payments/:reference')
  status(@CurrentUser() p: Principal, @Param('reference') ref: string) {
    return this.wallet.paymentStatus(p, ref);
  }

  @Public()
  @Post('webhooks/paystack')
  @HttpCode(200)
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-paystack-signature') sig: string | undefined) {
    if (!req.rawBody) throw new AppError(400, 'raw_body_missing', 'Bad request.');
    return this.wallet.handleWebhook(req.rawBody, sig);
  }
}
