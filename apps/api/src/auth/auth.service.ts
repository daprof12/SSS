// Phone OTP sign-in (C6), refresh sessions and sign-out. Copy is the States doc's.
import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mfaRequired } from '@erp/domain';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { Audit } from '../core/audit';
import { TokenService, type RoleGrant } from '../core/auth';
import { CONFIG, type AppConfig } from '../core/config';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';

export const OTP = {
  ttlSeconds: 5 * 60, // C3
  maxAttempts: 5, // C3
  resendSeconds: 60, // C3
  perPhonePerHour: 5,
  perIpPerHour: 20,
} as const;
const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_DAYS = 30;

/** 0803…, 803…, +234803… → +234803…; null if it is not a Nigerian mobile number. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/[\s()-]/g, '');
  const n = d.startsWith('+234') ? d : d.startsWith('234') ? `+${d}` : d.startsWith('0') ? `+234${d.slice(1)}` : /^\d{10}$/.test(d) ? `+234${d}` : d;
  return /^\+234[789]\d{9}$/.test(n) ? n : null;
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const mask = (p: string) => `${p.slice(0, 7)}•••${p.slice(-2)}`;

export interface DeviceInfo {
  label?: string;
  platform?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SMS) private readonly sms: SmsAdapter,
  ) {}

  private codeHash(phone: string, code: string) {
    return createHmac('sha256', this.config.otpSecret).update(`${phone}|${code}`).digest('hex');
  }

  /** Same answer whether or not the number has an account (no account discovery). */
  async startOtp(rawPhone: string, ip?: string) {
    const phone = normalisePhone(rawPhone);
    if (!phone) throw new AppError(422, 'validation_failed', 'Enter a Nigerian phone number.', { fields: [{ field: 'phone', message: 'Enter a Nigerian phone number.' }] });

    const last = (await this.db.query(`select created_at from otp_challenges where phone = $1 order by created_at desc limit 1`, [phone])).rows[0];
    if (last) {
      const wait = OTP.resendSeconds - Math.floor((Date.now() - new Date(last.created_at).getTime()) / 1000);
      if (wait > 0) throw new AppError(429, 'resend_cooldown', `Wait ${wait} seconds before asking for a new code.`, { retryInSeconds: wait });
    }
    const counts = (
      await this.db.query(
        `select count(*) filter (where phone = $1)::int as phone, count(*) filter (where ip = $2::inet)::int as ip
           from otp_challenges where created_at > now() - interval '1 hour'`,
        [phone, ip ?? null],
      )
    ).rows[0];
    if (counts.phone >= OTP.perPhonePerHour || (ip && counts.ip >= OTP.perIpPerHour)) {
      throw new AppError(429, 'too_many_codes', 'Too many codes asked for. Try again in an hour, or call 112 if you are in danger.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.query(
      `insert into otp_challenges (phone, code_hash, max_attempts, expires_at, ip) values ($1, $2, $3, now() + make_interval(secs => $4), $5)`,
      [phone, this.codeHash(phone, code), OTP.maxAttempts, OTP.ttlSeconds, ip ?? null],
    );
    await this.sms.send({ to: phone, urgent: true, body: `Your ERP code is ${code}. It expires in 5 minutes. Never share it, not even with us.` });
    return { sent: true, phone: mask(phone), expiresInSeconds: OTP.ttlSeconds, resendInSeconds: OTP.resendSeconds };
  }

  async verifyOtp(rawPhone: string, code: string, device: DeviceInfo) {
    const phone = normalisePhone(rawPhone);
    if (!phone) throw new AppError(422, 'validation_failed', 'Enter a Nigerian phone number.');
    if (!/^\d{6}$/.test(code)) throw new AppError(422, 'validation_failed', 'Enter the 6-digit code.', { fields: [{ field: 'code', message: 'Enter the 6-digit code.' }] });

    const ch = (await this.db.query(`select * from otp_challenges where phone = $1 and consumed_at is null order by created_at desc limit 1`, [phone])).rows[0];
    if (!ch || new Date(ch.expires_at) < new Date()) throw new AppError(400, 'code_expired', 'Code expired. Send a new one.');
    if (ch.attempts >= ch.max_attempts) throw new AppError(429, 'code_locked', 'Too many tries. Send a new code.');

    const ok = timingSafeEqual(Buffer.from(this.codeHash(phone, code), 'hex'), Buffer.from(ch.code_hash, 'hex'));
    if (!ok) {
      // Recorded outside any transaction so a wrong guess always counts.
      const r = await this.db.query(`update otp_challenges set attempts = attempts + 1 where id = $1 returning attempts, max_attempts`, [ch.id]);
      const left = r.rows[0].max_attempts - r.rows[0].attempts;
      throw new AppError(400, 'code_wrong', left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many tries. Send a new code.', { triesLeft: Math.max(0, left) });
    }

    return this.db.tx(async (c) => {
      // One use only: the guarded update wins once even if two requests race.
      const used = await c.query(`update otp_challenges set consumed_at = now() where id = $1 and consumed_at is null and attempts < max_attempts returning id`, [ch.id]);
      if (!used.rowCount) throw new AppError(400, 'code_expired', 'Code expired. Send a new one.');

      let user = (await c.query(`select id, display_name, status, mfa_enabled from users where phone = $1`, [phone])).rows[0];
      const isNew = !user;
      if (!user) {
        user = (await c.query(`insert into users (phone, display_name) values ($1, '') returning id, display_name, status, mfa_enabled`, [phone])).rows[0];
        await c.query(`insert into user_roles (user_id, role, scope_type) values ($1, 'citizen', 'self')`, [user.id]);
        await c.query(`insert into trust_scores (user_id) values ($1) on conflict do nothing`, [user.id]);
      }
      if (user.status !== 'active') throw new AppError(403, 'account_blocked', 'This account cannot sign in. Contact support.');

      const session = await this.openSession(c, user.id, user.mfa_enabled, device);
      await this.audit.write({ actorId: user.id, action: isNew ? 'auth.sign_up' : 'auth.sign_in', entity: 'user', entityId: user.id, ip: device.ip, payload: { method: 'phone_otp', device: device.label ?? null } }, c);
      return { ...session, isNew, needsName: !user.display_name };
    });
  }

  private async roles(c: Queryable, userId: string): Promise<RoleGrant[]> {
    return (await c.query(`select role, scope_type, scope_id from user_roles where user_id = $1`, [userId])).rows.map((r) => ({ role: r.role, scopeType: r.scope_type, scopeId: r.scope_id }));
  }

  /** Staff need a second factor (Public Issues doc §5). Phone OTP alone is one factor. */
  private mfaFor(roles: RoleGrant[], mfaEnabled: boolean, secondFactorPassed: boolean) {
    return roles.some((r) => mfaRequired.has(r.role)) ? mfaEnabled && secondFactorPassed : true;
  }

  async openSession(c: Queryable, userId: string, mfaEnabled: boolean, device: DeviceInfo, secondFactorPassed = false) {
    const refresh = randomBytes(32).toString('base64url');
    const s = (
      await c.query(
        `insert into sessions (user_id, ip, user_agent, label, platform, refresh_hash, mfa_passed, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) returning id`,
        [userId, device.ip ?? null, device.userAgent ?? null, device.label ?? null, device.platform ?? null, sha256(refresh), secondFactorPassed, REFRESH_TTL_DAYS],
      )
    ).rows[0];
    const roles = await this.roles(c, userId);
    const accessToken = await this.tokens.sign({ userId, sessionId: s.id, roles, mfa: this.mfaFor(roles, mfaEnabled, secondFactorPassed) }, ACCESS_TTL_S);
    const staff = roles.some((r) => mfaRequired.has(r.role));
    return {
      accessToken,
      refreshToken: refresh,
      expiresInSeconds: ACCESS_TTL_S,
      userId,
      surface: roles.some((r) => r.role === 'officer') ? ('officer' as const) : ('citizen' as const),
      secondFactorRequired: staff && !this.mfaFor(roles, mfaEnabled, secondFactorPassed),
    };
  }

  /** Rotates the refresh token on every use; an old token never works twice. */
  async refresh(refreshToken: string) {
    return this.db.tx(async (c) => {
      const s = (
        await c.query(
          `select s.id, s.user_id, s.mfa_passed, u.mfa_enabled, u.status from sessions s join users u on u.id = s.user_id
            where s.refresh_hash = $1 and s.revoked_at is null and s.expires_at > now() for update of s`,
          [sha256(refreshToken)],
        )
      ).rows[0];
      if (!s || s.status !== 'active') throw new AppError(401, 'session_ended', 'Your session has ended. Sign in again.');
      const next = randomBytes(32).toString('base64url');
      await c.query(`update sessions set refresh_hash = $2, last_seen_at = now() where id = $1`, [s.id, sha256(next)]);
      const roles = await this.roles(c, s.user_id);
      const accessToken = await this.tokens.sign({ userId: s.user_id, sessionId: s.id, roles, mfa: this.mfaFor(roles, s.mfa_enabled, s.mfa_passed) }, ACCESS_TTL_S);
      return { accessToken, refreshToken: next, expiresInSeconds: ACCESS_TTL_S };
    });
  }

  async signOut(userId: string, sessionId: string) {
    await this.db.query(`update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null`, [sessionId, userId]);
    await this.audit.write({ actorId: userId, action: 'auth.sign_out', entity: 'session', entityId: sessionId });
  }

  async sessions(userId: string, current: string) {
    const r = await this.db.query(
      `select id, label, platform, ip, created_at, last_seen_at from sessions where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc`,
      [userId],
    );
    return r.rows.map((s) => ({ id: s.id, label: s.label ?? 'Unknown device', platform: s.platform, lastSeen: s.last_seen_at, signedIn: s.created_at, current: s.id === current }));
  }

  async revoke(userId: string, sessionId: string, current: string) {
    if (sessionId === current) throw new AppError(409, 'use_sign_out', 'To end this session, sign out.');
    const r = await this.db.query(`update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null`, [sessionId, userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Session not found.');
    await this.audit.write({ actorId: userId, action: 'auth.revoke_session', entity: 'session', entityId: sessionId });
  }
}
