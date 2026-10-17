import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { AppError, ZodPipe } from '../core/http';
import { MAX_BYTES, MediaService } from './media.service';

const Owner = z.enum(['tip', 'issue_case', 'incident']);
const RegisterBody = z.object({
  ownerType: Owner,
  ownerId: z.string().uuid(),
  contentType: z.string().max(60),
  sizeBytes: z.number().int().positive(),
});
const ListQuery = z.object({ ownerType: Owner, ownerId: z.string().uuid() });

/** Reads a raw body with a hard size cap (express parsers skip binary bodies). */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError(413, 'file_rejected', 'This file is too large or not supported.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

@Controller()
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Post('media')
  register(@CurrentUser() p: Principal, @Body(new ZodPipe(RegisterBody)) b: z.infer<typeof RegisterBody>) {
    return this.media.register(p, b);
  }

  @Put('media/:id/content')
  async upload(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.media.upload(p, id, await readBody(req, MAX_BYTES + 1));
  }

  @Get('attachments')
  list(@CurrentUser() p: Principal, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.media.list(p, q.ownerType, q.ownerId);
  }

  @Get('media/:id/content')
  async content(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, contentType } = await this.media.read(p, id);
    // Private evidence: never cached by shared caches, never sniffed as another type.
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.send(bytes);
  }
}
