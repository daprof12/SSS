import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { accountDeletionBlockers, kobo, mfaRequired } from '@erp/domain';
import { KYC, type KycAdapter } from '../adapters/kyc';
import { POSTCODE, PostcodeUnavailable, type PostcodeAdapter } from '../adapters/postcode';
import { Audit } from '../core/audit';
import { CurrentUser, type Principal } from '../core/auth';
import { Db } from '../core/db';
import { AppError, ZodPipe } from '../core/http';
import { WalletService } from '../wallet/wallet.service';

const Prefs = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    locale: z.enum(['en', 'ha', 'yo', 'ig', 'pcm']),
    reduceMotion: z.boolean(),
    discreetMode: z.boolean(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change.');

const HomeBody = z.object({ postcode: z.string().trim().min(3, 'Enter a postcode.').max(12) });
const NotifTab = z.enum(['all', 'reports', 'money', 'account']).default('all');
const NgPhone = z.string().regex(/^\+234\d{10}$/, 'Enter a Nigerian phone number.');
const Contact = z.object({
  name: z.string().trim().min(1).max(80),
  phone: NgPhone,
  shareLocation: z.boolean().default(false),
  includeViolenceReports: z.boolean().default(false),
});
const KycBody = z.object({
  idType: z.enum(['nin', 'bvn']),
  idNumber: z.string().regex(/^\d{11}$/, 'Check your ID number.'),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  liveness: z.boolean(),
});

const KYC_MESSAGES: Record<string, string> = {
  id_not_found: 'This ID number does not look right. Check and try again.',
  details_mismatch: 'We could not match your details to this ID. Check the spelling and try again.',
  face_mismatch: 'We could not match your face to this ID. Try again in good light.',
  liveness_failed: 'Move to better light and try again.',
};

@Controller('me')
export class MeController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(KYC) private readonly kyc: KycAdapter,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
  ) {}

  @Get()
  async me(@CurrentUser() p: Principal) {
    const u = (
      await this.db.query(
        `select id, display_name, phone, email, locale, theme, reduce_motion, discreet_mode, mfa_enabled, pin_hash is not null as has_pin from users where id = $1`,
        [p.userId],
      )
    ).rows[0];
    if (!u) throw new AppError(404, 'not_found', 'Account not found.');
    const kyc = (await this.db.query(`select status, id_masked, verified_at from kyc_verifications where user_id = $1 order by created_at desc limit 1`, [p.userId])).rows[0];
    const trust = (await this.db.query(`select score, band from trust_scores where user_id = $1`, [p.userId])).rows[0];
    return {
      id: u.id,
      name: u.display_name,
      // Masked for display; full values only on the edit screen after step-up.
      phone: u.phone ? `${u.phone.slice(0, 7)}•••${u.phone.slice(-2)}` : null,
      email: u.email,
      roles: p.roles,
      preferences: { theme: u.theme, locale: u.locale, reduceMotion: u.reduce_motion, discreetMode: u.discreet_mode },
      security: { mfaEnabled: u.mfa_enabled, mfaRequired: p.roles.some((r) => mfaRequired.has(r.role)), hasPin: u.has_pin },
      kyc: kyc ? { status: kyc.status, idMasked: kyc.id_masked, verifiedAt: kyc.verified_at } : { status: 'not_started' },
      trust: trust ?? { score: 70, band: 'normal' },
    };
  }

  @Patch('preferences')
  async prefs(@CurrentUser() p: Principal, @Body(new ZodPipe(Prefs)) b: z.infer<typeof Prefs>) {
    const map = { theme: 'theme', locale: 'locale', reduceMotion: 'reduce_motion', discreetMode: 'discreet_mode' } as const;
    const keys = Object.keys(b) as Array<keyof typeof map>;
    await this.db.query(`update users set ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1`, [p.userId, ...keys.map((k) => b[k])]);
    return { ok: true };
  }

  @Post('kyc')
  async verify(@CurrentUser() p: Principal, @Body(new ZodPipe(KycBody)) b: z.infer<typeof KycBody>) {
    const tries = await this.db.query(`select count(*)::int as n from kyc_verifications where user_id = $1 and status = 'failed' and created_at > now() - interval '1 day'`, [p.userId]);
    if (tries.rows[0].n >= 3) {
      throw new AppError(429, 'kyc_locked', 'We could not verify you. Visit a verification point or contact support.');
    }
    const r = await this.kyc.verify(b, { liveness: b.liveness });
    // Only the result, reference and masked ID are stored — never the raw number.
    await this.db.query(
      `insert into kyc_verifications (user_id, provider, provider_ref, id_type, id_masked, selfie_match, liveness, status, failure_reason, verified_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $8 = 'verified' then now() end)`,
      [p.userId, this.kyc.name, r.providerRef, b.idType, r.idMasked, r.status === 'verified' ? r.selfieMatch : null, b.liveness, r.status, r.status === 'failed' ? r.reason : null],
    );
    await this.audit.write({ actorId: p.userId, action: 'kyc.attempt', entity: 'user', entityId: p.userId, payload: { status: r.status, provider: this.kyc.name } });
    if (r.status === 'failed') return { status: 'failed', message: KYC_MESSAGES[r.reason], triesLeft: Math.max(0, 2 - tries.rows[0].n) };
    if (r.status === 'manual_review') return { status: 'manual_review', message: 'We are checking your details. This usually takes a few hours.' };
    return { status: 'verified', idMasked: r.idMasked };
  }

  @Get('emergency-contacts')
  async contacts(@CurrentUser() p: Principal) {
    const r = await this.db.query(
      `select id, name, phone, verified_at, share_location, include_violence_reports from emergency_contacts where user_id = $1 order by created_at`,
      [p.userId],
    );
    return { max: 3, contacts: r.rows };
  }

  @Post('emergency-contacts')
  async addContact(@CurrentUser() p: Principal, @Body(new ZodPipe(Contact)) b: z.infer<typeof Contact>) {
    try {
      const r = await this.db.query(
        `insert into emergency_contacts (user_id, name, phone, share_location, include_violence_reports) values ($1, $2, $3, $4, $5) returning id`,
        [p.userId, b.name, b.phone, b.shareLocation, b.includeViolenceReports],
      );
      return { id: r.rows[0].id };
    } catch (e: any) {
      if (e.code === 'P0002') throw new AppError(422, 'limit_reached', 'You can add up to 3 emergency contacts.');
      if (e.code === '23505') throw new AppError(422, 'duplicate', 'This person is already one of your contacts.');
      throw e;
    }
  }

  @Delete('emergency-contacts/:id')
  @HttpCode(204)
  async removeContact(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.query(`delete from emergency_contacts where id = $1 and user_id = $2`, [id, p.userId]);
  }

  /** Saved places (REP-3): the home building shown on the Home location line. */
  @Get('places')
  async places(@CurrentUser() p: Principal) {
    const r = await this.db.query(
      `select sp.id, sp.label, sp.is_home, sp.verified, l.postcode, l.address_text, l.area_label,
              st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lng
         from saved_places sp join locations l on l.id = sp.location_id where sp.user_id = $1 order by sp.is_home desc, sp.created_at`,
      [p.userId],
    );
    return r.rows.map((x) => ({ id: x.id, label: x.label, isHome: x.is_home, verified: x.verified, postcode: x.postcode, address: x.address_text, area: x.area_label, lat: x.lat, lng: x.lng }));
  }

  @Put('places/home')
  async setHome(@CurrentUser() p: Principal, @Body(new ZodPipe(HomeBody)) b: z.infer<typeof HomeBody>) {
    let building;
    try {
      building = await this.postcode.lookup(b.postcode);
    } catch (e) {
      if (e instanceof PostcodeUnavailable) throw new AppError(503, 'postcode_unavailable', 'Postcode lookup is not available. Try again soon.');
      throw e;
    }
    if (!building) throw new AppError(404, 'postcode_not_found', 'We could not find that building. Check the postcode or pick it from the list.');
    await this.db.tx(async (c) => {
      const loc = await c.query(
        `insert into locations (postcode, building_name, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
         values ($1, $2, $3, $4, $5, $6, $7, $8, st_setsrid(st_makepoint($10, $9), 4326)::geography)
         on conflict (postcode) do update set fetched_at = now() returning id`,
        [building.postcode, building.name ?? null, building.address, building.stateId, building.lgaId, building.districtId, building.areaId, building.areaLabel, building.lat, building.lng],
      );
      await c.query(`delete from saved_places where user_id = $1 and is_home`, [p.userId]);
      // Verified once the address check confirms it (KYC address step); unverified until then.
      await c.query(`insert into saved_places (user_id, label, location_id, is_home, verified) values ($1, 'Home', $2, true, false)`, [p.userId, loc.rows[0].id]);
    });
    await this.audit.write({ actorId: p.userId, action: 'place.set_home', entity: 'user', entityId: p.userId, payload: { postcode: building.postcode } });
    return { postcode: building.postcode, address: building.address, area: building.areaLabel };
  }

  /** Notification centre: tabs, unread dot, mark all read (States doc). In-app copies kept 30 days. */
  @Get('notifications')
  async notifications(@CurrentUser() p: Principal, @Query('tab', new ZodPipe(NotifTab)) tab: z.infer<typeof NotifTab>) {
    const groups: Record<z.infer<typeof NotifTab>, string[] | null> = {
      all: null,
      reports: ['safety', 'reports', 'dispatch', 'team'],
      money: ['money'],
      account: ['account', 'tips', 'learn', 'marketing'],
    };
    const g = groups[tab];
    const [items, unread] = await Promise.all([
      this.db.query(
        `select id, type, grp, title, body, deep_link, sent_at, read_at from notifications
          where user_id = $1 and channel = 'in_app' and sent_at > now() - interval '30 days' and ($2::text[] is null or grp = any($2::text[]))
          order by sent_at desc limit 100`,
        [p.userId, g],
      ),
      this.db.query(`select count(*)::int as n from notifications where user_id = $1 and channel = 'in_app' and read_at is null and sent_at > now() - interval '30 days'`, [p.userId]),
    ]);
    return {
      unread: unread.rows[0].n,
      items: items.rows.map((n) => ({ id: n.id, type: n.type, group: n.grp, title: n.title, body: n.body, link: n.deep_link, at: n.sent_at, unread: !n.read_at })),
      empty: 'Nothing new.',
    };
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  async markRead(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.query(`update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2`, [id, p.userId]);
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  async markAllRead(@CurrentUser() p: Principal) {
    await this.db.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [p.userId]);
  }

  /** Decided 2026-10-17: deletion is blocked until settled; the screen lists each blocker. */
  @Get('deletion-check')
  async deletionCheck(@CurrentUser() p: Principal) {
    const w = await this.wallet.summary(p.userId);
    const fines = (await this.db.query(`select count(*)::int as n from fines where user_id = $1 and state in ('open', 'appealed', 'reduced', 'upheld')`, [p.userId])).rows[0].n;
    const wd = (await this.db.query(`select count(*)::int as n from withdrawals where wallet_id = $1 and state in ('requested', 'held_first', 'processing', 'sent')`, [w.walletId])).rows[0].n;
    const sub = (await this.db.query(`select count(*)::int as n from subscriptions where owner_id = $1 and state not in ('cancelled', 'draft')`, [p.userId])).rows[0].n;
    const blockers = accountDeletionBlockers({
      walletBalance: kobo(w.availableKobo),
      heldBalance: kobo(w.heldKobo),
      openFines: fines,
      pendingWithdrawals: wd,
      activeSubscription: sub > 0,
    });
    const copy: Record<string, { message: string; action: string }> = {
      wallet_balance: { message: `You have ${w.available} in your wallet${w.heldKobo ? ` and ${w.held} on hold` : ''}. Withdraw it first.`, action: '/wallet/withdraw' },
      open_fines: { message: 'You have a fine that is open or under appeal.', action: '/fines' },
      pending_withdrawal: { message: 'A withdrawal is still on its way to your bank.', action: '/wallet' },
      active_subscription: { message: 'Cancel your home plan first.', action: '/subscription' },
    };
    return { canDelete: blockers.length === 0, blockers: blockers.map((b) => ({ code: b, ...copy[b] })) };
  }
}
