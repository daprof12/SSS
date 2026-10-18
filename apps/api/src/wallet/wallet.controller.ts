import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { NIGERIAN_BANKS } from '@erp/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type Principal } from '../core/auth';
import { AppError, ZodPipe } from '../core/http';
import { WalletService } from './wallet.service';
import { WithdrawalsService } from './withdrawals.service';

const FundBody = z.object({
  amountKobo: z.number().int().positive(),
  method: z.enum(['card', 'bank_transfer', 'ussd']),
});
const pin = z.string().regex(/^\d{4}$/, 'Use 4 digits.');
const BankBody = z.object({ bankCode: z.string().max(10), accountNumber: z.string().trim().max(10), pin: pin.optional() });
const PinBody = z.object({ pin, currentPin: pin.optional() });
const ResetBody = z.object({ code: z.string().trim().max(6), pin });
const QuoteBody = z.object({ amountKobo: z.number().int().positive('Enter an amount.') });
const WithdrawBody = z.object({ amountKobo: z.number().int().positive('Enter an amount.'), pin });
const Tab = z.enum(['all', 'money_in', 'money_out', 'rewards', 'bounties', 'payments', 'withdrawals']).default('all');

@Controller()
export class WalletController {
  constructor(
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  // ---------- withdrawals (bank account in the verified name, PIN, first one held)
  @Get('banks')
  banks() {
    return NIGERIAN_BANKS;
  }

  @Get('me/bank-account')
  bank(@CurrentUser() p: Principal) {
    return this.withdrawals.bankAccount(p);
  }

  @Post('me/bank-account/resolve')
  resolve(@CurrentUser() p: Principal, @Body(new ZodPipe(BankBody)) b: z.infer<typeof BankBody>) {
    return this.withdrawals.resolve(p, b.bankCode, b.accountNumber);
  }

  @Put('me/bank-account')
  setBank(@CurrentUser() p: Principal, @Body(new ZodPipe(BankBody)) b: z.infer<typeof BankBody>) {
    return this.withdrawals.setBankAccount(p, b);
  }

  @Get('me/pin')
  pinStatus(@CurrentUser() p: Principal) {
    return this.withdrawals.pinStatus(p);
  }

  @Put('me/pin')
  setPin(@CurrentUser() p: Principal, @Body(new ZodPipe(PinBody)) b: z.infer<typeof PinBody>) {
    return this.withdrawals.setPin(p, b);
  }

  @Post('me/pin/reset/start')
  startReset(@CurrentUser() p: Principal, @Req() req: Request) {
    return this.withdrawals.startPinReset(p, req.ip);
  }

  @Post('me/pin/reset')
  reset(@CurrentUser() p: Principal, @Body(new ZodPipe(ResetBody)) b: z.infer<typeof ResetBody>) {
    return this.withdrawals.resetPin(p, b);
  }

  @Post('me/withdrawals/quote')
  quote(@CurrentUser() p: Principal, @Body(new ZodPipe(QuoteBody)) b: z.infer<typeof QuoteBody>) {
    return this.withdrawals.quote(p, b.amountKobo);
  }

  @Get('me/withdrawals')
  list(@CurrentUser() p: Principal) {
    return this.withdrawals.list(p);
  }

  @Post('me/withdrawals')
  withdraw(@CurrentUser() p: Principal, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(WithdrawBody)) b: z.infer<typeof WithdrawBody>) {
    if (!key || key.length < 8) throw new AppError(400, 'idempotency_key_required', 'Try again.');
    return this.withdrawals.create(p, { ...b, idempotencyKey: key });
  }

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
