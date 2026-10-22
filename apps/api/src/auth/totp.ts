// Authenticator-app codes (TOTP, RFC 6238: SHA-1, 6 digits, 30-second steps), with the secret kept
// encrypted at rest (AES-256-GCM). No third-party library: Node's crypto does all of it.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_S = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit code for one 30-second step. */
export function totpAt(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

export const stepNow = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_S);

/**
 * The step a code matches, allowing one step either side for clock drift, and never a step at or
 * before `after` (so a code, once used, cannot be used again). Null if it does not match.
 */
export function matchStep(secret: Buffer, code: string, after: number | null, now = stepNow()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const s of [now - 1, now, now + 1]) {
    if (after != null && s <= after) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(code))) return s;
  }
  return null;
}

export const newSecret = () => randomBytes(20);

const keyFrom = (pepper: string) => createHash('sha256').update(`totp-secret-key|${pepper}`).digest();

export function sealSecret(secret: Buffer, pepper: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(pepper), iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function openSecret(sealed: string, pepper: string): Buffer {
  const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', keyFrom(pepper), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]);
}

/** Ten one-time recovery codes like "k7q2-9xm4", for when the phone with the app is lost. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
