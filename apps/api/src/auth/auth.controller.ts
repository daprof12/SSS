import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { AuthService } from './auth.service';

const StartBody = z.object({ phone: z.string().trim().min(7).max(20) });
const VerifyBody = z.object({
  phone: z.string().trim().min(7).max(20),
  code: z.string().trim(),
  device: z.object({ label: z.string().max(80).optional(), platform: z.string().max(40).optional() }).default({}),
});
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
