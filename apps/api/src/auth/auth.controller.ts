import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AllowPendingMfa, CurrentUser, Public, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { AuthService } from './auth.service';

const StartBody = z.object({ phone: z.string().trim().min(7).max(20) });
const VerifyBody = z.object({
  phone: z.string().trim().min(7).max(20),
  code: z.string().trim(),
  device: z.object({ label: z.string().max(80).optional(), platform: z.string().max(40).optional() }).default({}),
});
const CodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your app.') });
const SecondStepBody = z
  .object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your app.').optional(), recoveryCode: z.string().trim().min(8).max(20).optional() })
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: 'Enter the code from your app, or one recovery code.', path: ['code'] });
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

const ipOf = (req: Request) => (req.ip ?? '').replace(/^::ffff:/, '') || undefined;

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('otp/start')
  @HttpCode(200)
  start(@Body(new ZodPipe(StartBody)) b: z.infer<typeof StartBody>, @Req() req: Request) {
    return this.auth.startOtp(b.phone, ipOf(req));
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  verify(@Body(new ZodPipe(VerifyBody)) b: z.infer<typeof VerifyBody>, @Req() req: Request) {
    return this.auth.verifyOtp(b.phone, b.code, { ...b.device, ip: ipOf(req), userAgent: req.headers['user-agent'] });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(RefreshBody)) b: z.infer<typeof RefreshBody>) {
    return this.auth.refresh(b.refreshToken);
  }

  // Staff two-step login: after the phone code, set up the authenticator app once, then enter its code.
  @AllowPendingMfa()
  @Get('mfa')
  mfa(@CurrentUser() p: Principal) {
    return this.auth.mfaStatus(p.userId, p.sessionId);
  }

  @AllowPendingMfa()
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentUser() p: Principal) {
    return this.auth.mfaSetup(p.userId);
  }

  @AllowPendingMfa()
  @Post('mfa/confirm')
  @HttpCode(200)
  mfaConfirm(@CurrentUser() p: Principal, @Body(new ZodPipe(CodeBody)) b: z.infer<typeof CodeBody>, @Req() req: Request) {
    return this.auth.mfaConfirm(p.userId, p.sessionId, b.code, ipOf(req));
  }

  @AllowPendingMfa()
  @Post('mfa/verify')
  @HttpCode(200)
  mfaVerify(@CurrentUser() p: Principal, @Body(new ZodPipe(SecondStepBody)) b: z.infer<typeof SecondStepBody>, @Req() req: Request) {
    return this.auth.mfaVerify(p.userId, p.sessionId, b, ipOf(req));
  }

  @AllowPendingMfa()
  @Post('sign-out')
  @HttpCode(204)
  async signOut(@CurrentUser() p: Principal) {
    await this.auth.signOut(p.userId, p.sessionId);
  }

  /** Security → Active sessions (board "Profile security"). */
  @Get('sessions')
  sessions(@CurrentUser() p: Principal) {
    return this.auth.sessions(p.userId, p.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revoke(p.userId, id, p.sessionId);
  }
}
