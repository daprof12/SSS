// Photos and short videos for tips, public issues and live reports.
// Two steps so production can switch to presigned object-storage uploads:
// 1) register (type, size, owner checked) 2) send the bytes (checked again).
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Bus } from '../core/bus';
import { Db } from '../core/db';
import { AppError } from '../core/http';

export type OwnerType = 'tip' | 'issue_case' | 'incident' | 'learn_post';
export const MAX_BYTES = 10 * 1024 * 1024; // States doc: up to [10] MB
const TYPES: Record<string, 'photo' | 'video' | 'voice'> = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  // Voice notes: Chrome and Android record WebM/Opus, Safari and iOS record MP4/AAC.
  'audio/webm': 'voice',
  'audio/mp4': 'voice',
  'audio/ogg': 'voice',
  'audio/mpeg': 'voice',
};
/** Which containers each declared type may actually be. */
const CONTAINERS: Record<string, Container[]> = {
  'image/jpeg': ['jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'video/mp4': ['mp4', 'mov'],
  'video/quicktime': ['mov', 'mp4'],
  'audio/webm': ['webm'],
  'audio/mp4': ['mp4'],
  'audio/ogg': ['ogg'],
  'audio/mpeg': ['mp3'],
};
export const MAX_VOICE_SECONDS = 120;
const PER_OWNER = 6;
const TOO_BIG = 'This file is too large or not supported.';

type Container = 'jpeg' | 'png' | 'webp' | 'mp4' | 'mov' | 'webm' | 'ogg' | 'mp3';

/** The file's own header must match the type it claims (never trust the name or header). */
export function sniff(b: Buffer): Container | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') return b.toString('ascii', 8, 10) === 'qt' ? 'mov' : 'mp4';
  if (b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (b.length > 4 && b.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (b.length > 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))) return 'mp3';
  return null;
}

/**
 * Removes APP1 (EXIF/XMP) segments from a JPEG. Phone photos carry the GPS
 * position and device serials there; a tipper's home must never leak this way.
 */
export function stripJpegMetadata(b: Buffer): Buffer {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return b;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: image data follows
    const len = b.readUInt16BE(i + 2);
    const seg = b.subarray(i, i + 2 + len);
    if (marker !== 0xe1) parts.push(seg);
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

@Injectable()
export class MediaService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(Bus) private readonly bus: Bus,
  ) {}

  /** Who may see items on an owner: 'self' (the person's own record) or 'staff' (views are logged). */
  async access(p: Principal, ownerType: OwnerType, ownerId: string, forUpload = false): Promise<'self' | 'staff' | null> {
    if (ownerType === 'tip') {
      const t = (await this.db.query(`select user_id, agency_id, state from tips where id = $1`, [ownerId])).rows[0];
      if (!t) return null;
      if (t.user_id === p.userId) return forUpload && !['sent', 'in_queue', 'more_info'].includes(t.state) ? null : 'self';
      if (forUpload) return null;
      const staff = await this.db.query(`select 1 from user_roles where user_id = $1 and scope_type = 'agency' and scope_id = $2 and role in ('agency_admin', 'agency_finance')`, [p.userId, t.agency_id]);
      return staff.rowCount ? 'staff' : null;
    }
    if (ownerType === 'issue_case') {
      const k = (await this.db.query(`select agency_id, state from issue_cases where id = $1`, [ownerId])).rows[0];
      if (!k) return null;
      const mine = await this.db.query(`select 1 from issue_reports where case_id = $1 and user_id = $2`, [ownerId, p.userId]);
      if (mine.rowCount) return forUpload && k.state === 'fixed' ? null : 'self';
      if (forUpload) return null;
      const staff = await this.db.query(`select 1 from user_roles where user_id = $1 and scope_type = 'agency' and scope_id = $2`, [p.userId, k.agency_id]);
      return staff.rowCount ? 'staff' : null;
    }
    if (ownerType === 'learn_post') {
      // Platform team uploads to drafts; once live, anyone signed in can watch (no audit for public lessons).
      const lp = (await this.db.query(`select state from learn_posts where id = $1`, [ownerId])).rows[0];
      if (!lp) return null;
      const admin = hasRole(p, 'platform_admin');
      if (forUpload) return admin && lp.state === 'draft' ? 'self' : null;
      return lp.state === 'live' || admin ? 'self' : null;
    }
    // incident: the reporter adds; assigned officers and the station see it (clips rule, BRIEF-5).
    const i = (await this.db.query(`select reporter_id, station_id, state from incidents where id = $1`, [ownerId])).rows[0];
    if (!i) return null;
    const live = !['resolved', 'unfounded', 'cancelled', 'merged'].includes(i.state);
    if (i.reporter_id === p.userId) return forUpload && !live ? null : 'self';
    if (forUpload) return null;
    const officer = await this.db.query(`select 1 from incident_units where incident_id = $1 and officer_id = $2 and (state in ('accepted', 'en_route', 'on_scene') or accepted_at is not null)`, [ownerId, p.userId]);
    if (officer.rowCount) return 'staff';
    if (i.station_id && (hasRole(p, 'head', i.station_id) || hasRole(p, 'dispatcher', i.station_id))) return 'staff';
    return null;
  }

  async register(p: Principal, b: { ownerType: OwnerType; ownerId: string; contentType: string; sizeBytes: number; durationS?: number }) {
    // "audio/webm;codecs=opus" is still a WebM voice note.
    const contentType = b.contentType.split(';')[0]!.trim().toLowerCase();
    const kind = TYPES[contentType];
    if (!kind || b.sizeBytes <= 0 || b.sizeBytes > MAX_BYTES) throw new AppError(422, 'file_rejected', TOO_BIG);
    if (kind === 'voice' && (b.durationS ?? 0) > MAX_VOICE_SECONDS) throw new AppError(422, 'file_rejected', 'Voice notes can be up to 2 minutes.');
    if (!(await this.access(p, b.ownerType, b.ownerId, true))) throw new AppError(404, 'not_found', 'You cannot add files here.');
    const count = (await this.db.query(`select count(*)::int as n from media where owner_type = $1 and owner_id = $2 and uploader_id = $3 and state <> 'rejected'`, [b.ownerType, b.ownerId, p.userId])).rows[0].n;
    if (count >= PER_OWNER) throw new AppError(422, 'too_many_files', `You can add up to ${PER_OWNER} files here.`);
    const key = `${b.ownerType}/${b.ownerId}/${createHash('sha256').update(`${p.userId}${Date.now()}${Math.random()}`).digest('hex').slice(0, 24)}`;
    const m = (
      await this.db.query(
        `insert into media (owner_type, owner_id, uploader_id, kind, content_type, size_bytes, storage_key, duration_s) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [b.ownerType, b.ownerId, p.userId, kind, contentType, b.sizeBytes, key, kind === 'photo' ? null : (b.durationS ?? null)],
      )
    ).rows[0];
    return { id: m.id, uploadUrl: `/media/${m.id}/content`, method: 'PUT', maxBytes: MAX_BYTES };
  }

  async upload(p: Principal, id: string, bytes: Buffer) {
    const m = (await this.db.query(`select * from media where id = $1 and uploader_id = $2`, [id, p.userId])).rows[0];
    if (!m || m.state !== 'pending') throw new AppError(404, 'not_found', 'Upload not found.');
    const real = sniff(bytes);
    const typeOk = !!real && (CONTAINERS[m.content_type] ?? []).includes(real);
    if (!real || !typeOk || bytes.length > MAX_BYTES) {
      await this.db.query(`update media set state = 'rejected' where id = $1`, [id]);
      throw new AppError(422, 'file_rejected', TOO_BIG);
    }
    const clean = real === 'jpeg' ? stripJpegMetadata(bytes) : bytes;
    await this.db.tx(async (c) => {
      await c.query(`insert into media_blobs (storage_key, bytes) values ($1, $2)`, [m.storage_key, clean]);
      await c.query(`update media set state = 'ready', size_bytes = $2, sha256 = $3 where id = $1`, [id, clean.length, createHash('sha256').update(clean).digest('hex')]);
      // Tell whoever handles it that evidence arrived.
      if (m.owner_type === 'incident') {
        await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, 'reporter', 'add_info', $3, true)`, [
          m.owner_id,
          p.userId,
          { label: m.kind === 'photo' ? 'Photo added' : m.kind === 'voice' ? 'Voice note added' : 'Video added', mediaId: id },
        ]);
      }
    });
    if (m.owner_type === 'incident') this.bus.publishIncident({ incidentId: m.owner_id, kind: 'add_info', at: new Date().toISOString() });
    return { id, state: 'ready', kind: m.kind };
  }

  async list(p: Principal, ownerType: OwnerType, ownerId: string) {
    const who = await this.access(p, ownerType, ownerId);
    if (!who) throw new AppError(404, 'not_found', 'Not found.');
    const r = await this.db.query(
      `select id, kind, content_type, size_bytes, duration_s, created_at, uploader_id = $3 as mine from media where owner_type = $1 and owner_id = $2 and state = 'ready' order by created_at`,
      [ownerType, ownerId, p.userId],
    );
    return r.rows.map((m) => ({ id: m.id, kind: m.kind, contentType: m.content_type, sizeBytes: m.size_bytes, durationS: m.duration_s, mine: m.mine, at: m.created_at, url: `/media/${m.id}/content` }));
  }

  /** Bytes for viewing. Staff views are written to the audit log (each look is logged). */
  async read(p: Principal, id: string) {
    const m = (await this.db.query(`select * from media where id = $1 and state = 'ready'`, [id])).rows[0];
    if (!m) throw new AppError(404, 'not_found', 'Not found.');
    const who = await this.access(p, m.owner_type, m.owner_id);
    if (!who) throw new AppError(404, 'not_found', 'Not found.');
    if (who === 'staff') {
      await this.audit.write({ actorId: p.userId, action: 'media.view', entity: 'media', entityId: id, payload: { ownerType: m.owner_type, ownerId: m.owner_id } });
    }
    const blob = (await this.db.query(`select bytes from media_blobs where storage_key = $1`, [m.storage_key])).rows[0];
    return { bytes: blob.bytes as Buffer, contentType: m.content_type as string };
  }
}
