import { Body, Controller, Delete, Get, Inject, Ip, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { BriefService } from './brief.service';

const ShareBody = z.object({
  note: z.string().trim().min(3, 'Say why you are sharing this.').max(1000),
  days: z.number().int().min(1).max(14).default(7),
});
const Token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'This link is not valid.');

function sendPdf(res: Response, f: { filename: string; bytes: Buffer }) {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(f.bytes);
}

@Controller()
export class BriefController {
  constructor(@Inject(BriefService) private readonly brief: BriefService) {}

  @Get('agencies/:agencyId/issues/:caseId/brief.pdf')
  async pdf(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string, @Res() res: Response) {
    sendPdf(res, await this.brief.agencyPdf(p, a, k));
  }

  @Post('agencies/:agencyId/issues/:caseId/shares')
  share(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string, @Body(new ZodPipe(ShareBody)) b: z.infer<typeof ShareBody>) {
    return this.brief.share(p, a, k, b);
  }

  @Get('agencies/:agencyId/issues/:caseId/shares')
  shares(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string) {
    return this.brief.shares(p, a, k);
  }

  @Delete('agencies/:agencyId/issues/:caseId/shares/:shareId')
  revoke(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('caseId', ParseUUIDPipe) k: string, @Param('shareId', ParseUUIDPipe) s: string) {
    return this.brief.revoke(p, a, k, s);
  }

  // ---------- view-only link for someone outside the platform
  @Public()
  @Get('shared/issues/:token')
  opened(@Param('token', new ZodPipe(Token)) t: string, @Ip() ip: string) {
    return this.brief.opened(t, 'view', ip);
  }

  @Public()
  @Get('shared/issues/:token/brief.pdf')
  async sharedPdf(@Param('token', new ZodPipe(Token)) t: string, @Ip() ip: string, @Res() res: Response) {
    sendPdf(res, await this.brief.sharedPdf(t, ip));
  }
}
