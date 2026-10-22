import { Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Put, Req, Res } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Audit } from '../core/audit';
import { CurrentUser, Public, requirePerm, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';

const MAX_BYTES = 512 * 1024;

/** Where an agency's logo is served from, with its version so browsers fetch a new one when it changes. */
export const logoUrl = (agencyId: string, sha: string | null | undefined) => (sha ? `/agencies/${agencyId}/logo?v=${sha.slice(0, 12)}` : null);

/**
 * The agency, and station if any, a person works for: an agency admin's agency, a station head's or
 * dispatcher's station, or an officer's station. Used for the logo and names on their screens.
 */
export async function brandFor(c: Queryable, userId: string) {
  const r = (
    await c.query(
      `select a.id, a.name, s.id as station_id, s.name as station, l.sha
         from (
           select scope_id as agency_id, null::uuid as station_id, 0 as k from user_roles where user_id = $1 and scope_type = 'agency' and role in ('agency_admin', 'agency_finance')
           union all
           select st.agency_id, st.id, 1 from user_roles ur join stations st on st.id = ur.scope_id where ur.user_id = $1 and ur.scope_type = 'station'
           union all
           select st.agency_id, st.id, 2 from officers o join stations st on st.id = o.station_id where o.user_id = $1
         ) x join agencies a on a.id = x.agency_id left join stations s on s.id = x.station_id left join agency_logos l on l.agency_id = a.id
        order by x.k limit 1`,
      [userId],
    )
  ).rows[0];
  return r ? { agencyId: r.id as string, agencyName: r.name as string, stationId: (r.station_id as string | null) ?? null, stationName: (r.station as string | null) ?? null, logoUrl: logoUrl(r.id, r.sha) } : null;
}

/** The kind of image, from its first bytes (the Content-Type header is not trusted). */
function sniff(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit, keep reading but drop the bytes, so the person gets a clear answer.
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > limit * 8) req.destroy(); // far too big: stop reading
    });
    req.on('end', () => (size > limit ? reject(new AppError(413, 'file_too_large', 'Use an image under 512 KB.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

@Controller('agencies/:id/logo')
export class AgencyLogoController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  /** Anyone can load a logo: it appears on officers' phones and shared pages. */
  @Public()
  @Get()
  async get(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response) {
    const l = (await this.db.query(`select content_type, bytes, sha from agency_logos where agency_id = $1`, [id])).rows[0];
    if (!l) throw new AppError(404, 'not_found', 'This agency has no logo.');
    const etag = `"${l.sha}"`;
    res.set({ 'Content-Type': l.content_type, 'Cache-Control': 'public, max-age=300', ETag: etag, 'X-Content-Type-Options': 'nosniff' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.send(l.bytes);
  }

  /** Upload or replace: the image bytes as the body. PNG, JPEG or WebP, up to 512 KB. */
  @Put()
  async put(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    requirePerm(p, 'agency.operations', id);
    const bytes = await readBody(req, MAX_BYTES);
    const type = sniff(bytes);
    if (!type) throw new AppError(422, 'file_rejected', 'Use a PNG, JPEG or WebP image.');
    const sha = createHash('sha256').update(bytes).digest('hex');
    await this.db.query(
      `insert into agency_logos (agency_id, content_type, bytes, sha, updated_by) values ($1, $2, $3, $4, $5)
       on conflict (agency_id) do update set content_type = excluded.content_type, bytes = excluded.bytes, sha = excluded.sha, updated_by = excluded.updated_by, updated_at = now()`,
      [id, type, bytes, sha, p.userId],
    );
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.logo_set', entity: 'agency', entityId: id, payload: { contentType: type, sizeBytes: bytes.length } });
    return { message: 'Logo saved. Your stations and officers see it now.', logoUrl: logoUrl(id, sha) };
  }

  @Delete()
  async remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    requirePerm(p, 'agency.operations', id);
    await this.db.query(`delete from agency_logos where agency_id = $1`, [id]);
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.logo_removed', entity: 'agency', entityId: id });
    return { message: 'Logo removed.' };
  }
}
