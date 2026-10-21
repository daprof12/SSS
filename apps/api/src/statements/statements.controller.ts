import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Public, type Principal } from '../core/auth';
import { AppError, ZodPipe } from '../core/http';
import { LocationQuery } from '../core/location-filter';
import { hasRole } from '../core/auth';
import { StatementsService } from './statements.service';

const Note = z.object({ note: z.string().max(1000).default('') });
const Draft = z.object({
  language: z.enum(['auto', 'yo', 'ha', 'ig', 'pcm', 'en']),
  original: z.string().max(8000),
  english: z.string().max(12000).optional(),
  audioId: z.string().uuid().optional(),
});
const Sign = z.object({ pin: z.string(), confirm: z.boolean(), method: z.enum(['pin', 'biometric']).default('pin') });
const Ask = z.object({
  note: z.string().trim().max(1000).optional(),
  role: z.enum(['complainant', 'victim', 'witness', 'suspect', 'officer']).optional(),
  userId: z.string().uuid().optional(),
  phone: z.string().trim().max(20).optional(),
  name: z.string().trim().max(120).optional(),
  mode: z.enum(['self', 'in_person']).optional(),
  presentName: z.string().trim().max(120).optional(),
  presentRelation: z.string().trim().max(80).optional(),
  place: z.string().trim().max(160).optional(),
});
const Code = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.'), confirm: z.boolean() });
const ListQ = LocationQuery.extend({
  status: z.enum(['requested', 'draft', 'signed', 'change_requested']).optional(),
  role: z.enum(['complainant', 'victim', 'witness', 'suspect', 'officer']).optional(),
  q: z.string().max(60).optional(),
});
const Token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'This link is not valid.');

function sendPdf(res: Response, f: { filename: string; bytes: Buffer }) {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(f.bytes);
}

@Controller()
export class StatementsController {
  constructor(@Inject(StatementsService) private readonly statements: StatementsService) {}

  // Staff: officers on the incident, the station head and dispatchers.
  @Post('incidents/:id/statements')
  request(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Ask)) b: z.infer<typeof Ask>) {
    return this.statements.request(p, id, b);
  }

  @Get('incidents/:id/statement-parties')
  parties(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.parties(p, id);
  }

  // Taken in person by an officer: write it down, caution a suspect, send the code, confirm.
  @Put('statements/:id/in-person/draft')
  takeDraft(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Draft)) b: z.infer<typeof Draft>) {
    return this.statements.takeDraft(p, id, b);
  }

  @Post('statements/:id/in-person/caution')
  caution(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.caution(p, id);
  }

  @Post('statements/:id/in-person/send-code')
  sendCode(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.sendCode(p, id);
  }

  @Post('statements/:id/in-person/confirm')
  confirm(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Code)) b: z.infer<typeof Code>) {
    return this.statements.confirmCode(p, id, b);
  }

  // Lists: the station's and the agency's statements.
  @Get('me/station/statements')
  stationList(@CurrentUser() p: Principal, @Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    const sid = p.roles.find((r) => (r.role === 'head' || r.role === 'dispatcher') && r.scopeType === 'station')?.scopeId;
    if (!sid) throw new AppError(403, 'forbidden', 'This is for the station head and dispatchers.');
    return this.statements.list(p, { stationId: sid }, { ...q, state: q.status });
  }

  @Get('agencies/:id/statements')
  agencyList(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    if (!hasRole(p, 'agency_admin', id)) throw new AppError(404, 'not_found', 'Agency not found.');
    return this.statements.list(p, { agencyId: id }, { ...q, state: q.status });
  }

  @Get('incidents/:id/statements')
  forIncident(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.forIncident(p, id);
  }

  @Get('statements/:id')
  view(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.staffView(p, id);
  }

  @Get('statements/:id/statement.pdf')
  async pdf(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.statements.staffPdf(p, id));
  }

  @Post('statements/:id/request-change')
  change(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Note)) b: z.infer<typeof Note>) {
    return this.statements.requestChange(p, id, b.note);
  }

  @Post('statements/:id/translator-check')
  translator(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Note)) b: z.infer<typeof Note>) {
    return this.statements.translatorCheck(p, id, b.note);
  }

  // Citizen.
  @Get('me/statements')
  mine(@CurrentUser() p: Principal) {
    return this.statements.mine(p);
  }

  @Get('me/statements/:id')
  own(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.own(p, id);
  }

  @Put('me/statements/:id/draft')
  draft(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Draft)) b: z.infer<typeof Draft>) {
    return this.statements.saveDraft(p, id, b);
  }

  @Post('me/statements/:id/sign')
  sign(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Sign)) b: z.infer<typeof Sign>) {
    return this.statements.sign(p, id, b);
  }

  @Post('me/statements/:id/amend')
  amend(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.amend(p, id);
  }

  @Post('me/statements/:id/share')
  share(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.statements.share(p, id);
  }

  @Get('me/statements/:id/statement.pdf')
  async ownPdf(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.statements.ownPdf(p, id));
  }

  @Public()
  @Get('shared/statements/:token')
  shared(@Param('token', new ZodPipe(Token)) t: string) {
    return this.statements.shared(t);
  }
}
