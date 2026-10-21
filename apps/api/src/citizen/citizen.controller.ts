// Citizen profile rows (UX Gap Analysis §2.1): Security, Donations, Payments and receipts,
// Fines and appeals, Help and support. Admin review of fines lives here too (B8 step 4).
import { donationFee, formatNaira } from '@erp/domain';
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Ip, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { Audit } from '../core/audit';
import { CurrentUser, type Principal } from '../core/auth';
import { CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/db';
import { AppError, ZodPipe } from '../core/http';
import { DonationsService } from './donations.service';
import { FinesService } from './fines.service';

const mfaRequired = new Set(['officer', 'head', 'dispatcher', 'agency_admin', 'agency_finance', 'platform_admin', 'technician']);
const Code = z.object({ code: z.string().trim() });
const Bio = z.object({ on: z.boolean().optional(), openApp: z.boolean().optional(), signing: z.boolean().optional() }).refine((o) => Object.keys(o).length > 0, 'Nothing to change.');
const PayWith = z.enum(['wallet', 'card', 'bank_transfer', 'ussd']);
const Donate = z.object({
  targetType: z.enum(['agency', 'station', 'officer']),
  targetId: z.string().uuid(),
  amountKobo: z.number().int(),
  method: PayWith,
  showName: z.boolean().default(false),
  pin: z.string().optional(),
});
const Appeal = z.object({ reason: z.string(), note: z.string().max(1000).optional() });
const PayFine = z.object({ method: PayWith, pin: z.string().optional() });
const Review = z.object({ decision: z.enum(['confirm', 'overturn']), note: z.string().max(500).optional() });
const Decide = z.object({ decision: z.enum(['waive', 'reduce', 'uphold']), reason: z.string(), amountKobo: z.number().int().optional() });
const Ticket = z.object({ topic: z.enum(['app', 'money', 'report', 'device', 'account', 'other']), body: z.string().trim().min(10, 'Tell us a little more, at least 10 characters.').max(2000), relatedId: z.string().uuid().optional() });
const PayTab = z.enum(['all', 'donations', 'fines', 'wallet', 'home']).default('all');

const PURPOSE: Record<string, string> = {
  wallet_fund: 'Wallet top-up',
  donation: 'Donation',
  fine: 'Fine',
  subscription: 'Home plan',
  install: 'Installation fee',
};
const METHOD: Record<string, string> = { wallet: 'Wallet', card: 'Card', bank_transfer: 'Bank transfer', ussd: 'USSD' };

const FAQ = [
  { q: 'What happens after I press SOS?', a: 'You have 5 seconds to cancel. Then your report goes to the nearest team, and you see who is coming and when on the report page.' },
  { q: 'Can I cancel a report?', a: 'Yes. Cancelling within 30 seconds of sending is always free. After an officer is on the way, say why you are cancelling.' },
  { q: 'Who sees my name and phone?', a: 'Officers see "Verified citizen" and your trust level. Your phone number is masked. Tips are anonymous unless you choose otherwise.' },
  { q: 'Why was I fined?', a: 'A report marked a false alarm gives a warning first, then a fine. You can appeal within 14 days in Fines and appeals.' },
  { q: 'How do I get my money out?', a: 'Wallet, then Withdraw. The bank account must be in your verified name, and you confirm with your PIN.' },
  { q: 'My camera or street light is not working', a: 'Open My home devices, choose the device and tap Report a problem. Faults your plan covers are repaired free.' },
];

@Controller('me')
export class CitizenController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DonationsService) private readonly donations: DonationsService,
    @Inject(FinesService) private readonly fines: FinesService,
  ) {}

  // ---------------------------------------------------------------- Security (board "Profile security 2FA, PIN, face")

  @Get('security')
  async security(@CurrentUser() p: Principal) {
    const u = (await this.db.query(`select mfa_enabled, pin_hash is not null as has_pin, biometrics, biometric_open_app, biometric_signing from users where id = $1`, [p.userId])).rows[0];
    const devices = (await this.db.query(`select count(*)::int as n from trusted_devices where user_id = $1 and revoked_at is null`, [p.userId])).rows[0].n;
    const sessions = (await this.db.query(`select count(*)::int as n from sessions where user_id = $1 and revoked_at is null and expires_at > now()`, [p.userId])).rows[0].n;
    const codes = (await this.db.query(`select count(*) filter (where used_at is null)::int as left, count(*)::int as total from recovery_codes where user_id = $1`, [p.userId])).rows[0];
    return {
      twoStep: { on: u.mfa_enabled, required: p.roles.some((r) => mfaRequired.has(r.role)), method: 'SMS code' },
      pin: { set: u.has_pin, digits: 4 },
      biometrics: { on: u.biometrics, openApp: u.biometric_open_app, payments: true, signing: u.biometric_signing },
      trustedDevices: devices,
      sessions: { total: sessions, others: Math.max(0, sessions - 1) },
      recoveryCodes: { left: codes.left, generated: codes.total > 0 },
    };
  }

  /** Two-step login, step 1: a code by SMS to the account's phone (turning it on or off, or new recovery codes). */
  @Post('security/code')
  sendCode(@CurrentUser() p: Principal, @Ip() ip: string) {
    return this.auth.sendAccountCode(p.userId, 'mfa_setup', (code) => `Your ERP security code is ${code}. It expires in 5 minutes. If you did not ask for it, change nothing and tell us.`, ip);
  }

  @Post('security/2fa')
  async turnOn(@CurrentUser() p: Principal, @Body(new ZodPipe(Code)) b: z.infer<typeof Code>) {
    await this.auth.useAccountCode(p.userId, 'mfa_setup', b.code, this.db.pool);
    await this.db.query(`update users set mfa_enabled = true where id = $1`, [p.userId]);
    const codes = await this.newRecoveryCodes(p.userId);
    await this.audit.write({ actorId: p.userId, action: 'security.mfa_on', entity: 'user', entityId: p.userId });
    return { on: true, recoveryCodes: codes, message: 'Two-step login is on. Keep your recovery codes somewhere safe.' };
  }

  @Post('security/2fa/off')
  async turnOff(@CurrentUser() p: Principal, @Body(new ZodPipe(Code)) b: z.infer<typeof Code>) {
    if (p.roles.some((r) => mfaRequired.has(r.role))) throw new AppError(409, 'mfa_required', 'Two-step login is required for your role and cannot be turned off.');
    await this.auth.useAccountCode(p.userId, 'mfa_setup', b.code, this.db.pool);
    await this.db.query(`update users set mfa_enabled = false where id = $1`, [p.userId]);
    await this.db.query(`delete from recovery_codes where user_id = $1`, [p.userId]);
    await this.audit.write({ actorId: p.userId, action: 'security.mfa_off', entity: 'user', entityId: p.userId });
    return { on: false, message: 'Two-step login is off. You need it again to withdraw money.' };
  }

  /** New recovery codes replace the old ones; shown once. */
  @Post('security/recovery-codes')
  async recovery(@CurrentUser() p: Principal, @Body(new ZodPipe(Code)) b: z.infer<typeof Code>) {
    const on = (await this.db.query(`select mfa_enabled from users where id = $1`, [p.userId])).rows[0].mfa_enabled;
    if (!on) throw new AppError(409, 'mfa_off', 'Turn on two-step login first.');
    await this.auth.useAccountCode(p.userId, 'mfa_setup', b.code, this.db.pool);
    const codes = await this.newRecoveryCodes(p.userId);
    await this.audit.write({ actorId: p.userId, action: 'security.recovery_codes', entity: 'user', entityId: p.userId });
    return { recoveryCodes: codes, message: 'New codes made. The old ones no longer work.' };
  }

  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'));
    await this.db.tx(async (c) => {
      await c.query(`delete from recovery_codes where user_id = $1`, [userId]);
      for (const code of codes) {
        await c.query(`insert into recovery_codes (user_id, code_hash) values ($1, $2)`, [userId, createHash('sha256').update(`${code}:${this.config.otpSecret}`).digest('hex')]);
      }
    });
    return codes;
  }

  @Patch('security/biometrics')
  async biometrics(@CurrentUser() p: Principal, @Body(new ZodPipe(Bio)) b: z.infer<typeof Bio>) {
    const map = { on: 'biometrics', openApp: 'biometric_open_app', signing: 'biometric_signing' } as const;
    const keys = Object.keys(b) as Array<keyof typeof map>;
    await this.db.query(`update users set ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1`, [p.userId, ...keys.map((k) => b[k])]);
    return { ok: true };
  }

  @Get('security/devices')
  async devices(@CurrentUser() p: Principal) {
    const r = await this.db.query(`select id, label, platform, last_seen_at, created_at from trusted_devices where user_id = $1 and revoked_at is null order by coalesce(last_seen_at, created_at) desc`, [p.userId]);
    return r.rows.map((d) => ({ id: d.id, label: d.label, platform: d.platform, lastSeen: d.last_seen_at, added: d.created_at }));
  }

  @Delete('security/devices/:id')
  @HttpCode(204)
  async forget(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.query(`update trusted_devices set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null`, [id, p.userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Device not found.');
    await this.db.query(`update sessions set revoked_at = now() where device_id = $1 and revoked_at is null`, [id]);
    await this.audit.write({ actorId: p.userId, action: 'security.device_removed', entity: 'trusted_device', entityId: id });
  }

  // ---------------------------------------------------------------- Donations (board "Donate")

  @Get('donate/targets')
  targets(@CurrentUser() p: Principal) {
    return this.donations.targets(p);
  }

  @Get('donations')
  myDonations(@CurrentUser() p: Principal) {
    return this.donations.mine(p);
  }

  @Post('donations')
  donate(@CurrentUser() p: Principal, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(Donate)) b: z.infer<typeof Donate>) {
    if (!key || key.length < 8) throw new AppError(400, 'idempotency_key_required', 'Try again.');
    return this.donations.give(p, b, key);
  }

  // ---------------------------------------------------------------- Payments and receipts (PAY-3)

  @Get('payments')
  async payments(@CurrentUser() p: Principal, @Query('tab', new ZodPipe(PayTab)) tab: z.infer<typeof PayTab>) {
    const filter = { all: 'true', donations: `purpose = 'donation'`, fines: `purpose = 'fine'`, wallet: `purpose = 'wallet_fund'`, home: `purpose in ('subscription', 'install')` }[tab];
    const r = await this.db.query(
      `select provider_ref, receipt_no, purpose, amount_kobo, method, state, coalesce(paid_at, created_at) as at from payments
        where user_id = $1 and state in ('succeeded', 'pending', 'failed', 'refunded') and ${filter} order by created_at desc limit 100`,
      [p.userId],
    );
    const total = r.rows.filter((x) => x.state === 'succeeded').reduce((a, x) => a + Number(x.amount_kobo), 0);
    return {
      totalPaidKobo: total,
      items: r.rows.map((x) => ({
        reference: x.provider_ref,
        receiptNo: x.receipt_no,
        what: PURPOSE[x.purpose] ?? x.purpose,
        amountKobo: Number(x.amount_kobo),
        method: METHOD[x.method] ?? x.method,
        state: x.state,
        at: x.at,
      })),
    };
  }

  @Get('receipts/:reference')
  async receipt(@CurrentUser() p: Principal, @Param('reference') ref: string) {
    const x = (
      await this.db.query(
        `select py.*, u.display_name, u.phone from payments py join users u on u.id = py.user_id where py.provider_ref = $1 and py.user_id = $2`,
        [ref, p.userId],
      )
    ).rows[0];
    if (!x) throw new AppError(404, 'not_found', 'Receipt not found.');
    let to = 'Your wallet';
    let detail: string | null = null;
    let feeKobo: number | null = null;
    if (x.purpose === 'donation') {
      const d = (
        await this.db.query(
          `select coalesce(a.name, s.name, u.display_name) as target, d.target_type, d.show_name from donations d
             left join agencies a on d.target_type = 'agency' and a.id = d.target_id
             left join stations s on d.target_type = 'station' and s.id = d.target_id
             left join users u on d.target_type = 'officer' and u.id = d.target_id where d.id = $1`,
          [x.purpose_ref],
        )
      ).rows[0];
      to = d?.target ?? 'Responders';
      feeKobo = donationFee(Number(x.amount_kobo));
      detail = d ? (d.show_name ? 'Your name was shown to them.' : 'Given without your name.') : null;
    } else if (x.purpose === 'fine') {
      const f = (await this.db.query(`select number from fines where id = $1`, [x.purpose_ref])).rows[0];
      to = 'ERP platform';
      detail = f ? `Fine ${f.number}` : null;
    } else if (x.purpose === 'subscription' || x.purpose === 'install') {
      to = 'ERP platform';
    }
    return {
      receiptNo: x.receipt_no,
      reference: x.provider_ref,
      state: x.state,
      what: PURPOSE[x.purpose] ?? x.purpose,
      amountKobo: Number(x.amount_kobo),
      amount: formatNaira(Number(x.amount_kobo)),
      method: METHOD[x.method] ?? x.method,
      paidAt: x.paid_at,
      createdAt: x.created_at,
      from: x.display_name,
      to,
      detail,
      feeKobo,
      failureReason: x.state === 'failed' ? x.failure_reason ?? 'The payment did not go through.' : null,
    };
  }

  // Station head: confirm or overturn a false-alarm closure before any fine (B8 step 1).
  @Post('station/false-alarms/:incidentId/review')
  review(@CurrentUser() p: Principal, @Param('incidentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Review)) b: z.infer<typeof Review>) {
    return this.fines.review(p, id, b);
  }

  @Get('station/false-alarms')
  pending(@CurrentUser() p: Principal) {
    return this.fines.pendingReviews(p);
  }

  // ---------------------------------------------------------------- Fines and appeals (B8)

  @Get('fines')
  myFines(@CurrentUser() p: Principal) {
    return this.fines.mine(p);
  }

  @Get('fines/:id')
  fine(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.fines.one(p, id);
  }

  @Post('fines/:id/appeal')
  appeal(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Appeal)) b: z.infer<typeof Appeal>) {
    return this.fines.appeal(p, id, b);
  }

  @Post('fines/:id/pay')
  payFine(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodPipe(PayFine)) b: z.infer<typeof PayFine>) {
    if (!key || key.length < 8) throw new AppError(400, 'idempotency_key_required', 'Try again.');
    return this.fines.pay(p, id, b, key);
  }

  // ---------------------------------------------------------------- Help and support

  @Get('support')
  async support(@CurrentUser() p: Principal) {
    const r = await this.db.query(`select id, number, topic, body, state, reply, created_at, updated_at from support_tickets where user_id = $1 order by created_at desc limit 20`, [p.userId]);
    return {
      faq: FAQ,
      emergency: { number: '112', note: 'In danger and the app is not working? Call 112.' },
      tickets: r.rows.map((t) => ({ id: t.id, number: t.number, topic: t.topic, body: t.body, state: t.state, reply: t.reply, at: t.created_at, updatedAt: t.updated_at })),
    };
  }

  @Post('support/tickets')
  async ticket(@CurrentUser() p: Principal, @Body(new ZodPipe(Ticket)) b: z.infer<typeof Ticket>) {
    const t = await this.db.tx(async (c) => {
      let number = '';
      for (;;) {
        number = `S-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from support_tickets where number = $1`, [number])).rowCount) break;
      }
      const r = await c.query(`insert into support_tickets (number, user_id, topic, body, related_id) values ($1, $2, $3, $4, $5) returning id, number`, [number, p.userId, b.topic, b.body, b.relatedId ?? null]);
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'support_received', 'account', 'in_app', 'Message received', $2, '/help')`,
        [p.userId, `We got your message ${number}. We usually reply within one working day.`],
      );
      return r.rows[0];
    });
    return { id: t.id, number: t.number, message: `Sent. Your reference is ${t.number}. We usually reply within one working day.` };
  }
}

@Controller('admin')
export class AdminFinesController {
  constructor(@Inject(FinesService) private readonly fines: FinesService) {}

  @Get('fines')
  queue(@CurrentUser() p: Principal, @Query('state') state = 'appealed') {
    return this.fines.queue(p, ['all', 'open', 'appealed', 'waived', 'reduced', 'upheld', 'paid'].includes(state) ? state : 'appealed');
  }

  @Post('fines/:id/decision')
  decide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>) {
    return this.fines.decide(p, id, b);
  }
}

const Reply = z.object({ reply: z.string().trim().min(5, 'Write a reply the person will read.').max(2000), close: z.boolean().default(false) });

/** Help and support inbox for platform staff: read a message, reply, close. The person is told in the app. */
@Controller('admin/support')
export class AdminSupportController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  private admin(p: Principal) {
    if (!p.roles.some((r) => r.role === 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }

  @Get()
  async inbox(@CurrentUser() p: Principal, @Query('state') state = 'open') {
    this.admin(p);
    const st = ['open', 'answered', 'closed', 'all'].includes(state) ? state : 'open';
    const r = await this.db.query(
      `select t.*, u.display_name, u.phone, ru.display_name as replied_by_name from support_tickets t join users u on u.id = t.user_id left join users ru on ru.id = t.replied_by
        where ($1 = 'all' or t.state = $1) order by t.state = 'open' desc, t.created_at desc limit 100`,
      [st],
    );
    const counts = (await this.db.query(`select state, count(*)::int as n from support_tickets group by state`)).rows;
    const translator = (
      await this.db.query(
        `select s.id, s.number, s.translator_note, s.updated_at, i.type, l.postcode from statements s join incidents i on i.id = s.incident_id left join locations l on l.id = i.location_id
          where s.translator_check = 'requested' order by s.updated_at`,
      )
    ).rows;
    return {
      counts: Object.fromEntries(counts.map((x) => [x.state, x.n])),
      items: r.rows.map((t) => ({
        id: t.id,
        number: t.number,
        topic: t.topic,
        body: t.body,
        state: t.state,
        reply: t.reply,
        repliedBy: t.replied_by_name,
        repliedAt: t.replied_at,
        from: t.display_name,
        phone: t.phone ? `${t.phone.slice(0, 7)}•••${t.phone.slice(-2)}` : null,
        relatedId: t.related_id,
        at: t.created_at,
      })),
      translatorChecks: translator.map((x) => ({ id: x.id, number: x.number, note: x.translator_note, report: `${x.type}, ${x.postcode ?? 'GPS'}`, at: x.updated_at })),
    };
  }

  @Post(':id/reply')
  @HttpCode(200)
  async reply(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Reply)) b: z.infer<typeof Reply>) {
    this.admin(p);
    return this.db.tx(async (c) => {
      const t = (await c.query(`update support_tickets set reply = $2, state = $3, replied_by = $4, replied_at = now() where id = $1 returning user_id, number`, [id, b.reply, b.close ? 'closed' : 'answered', p.userId])).rows[0];
      if (!t) throw new AppError(404, 'not_found', 'Message not found.');
      await c.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'support_reply', 'account', 'in_app', 'We replied', $2, '/help')`,
        [t.user_id, `About ${t.number}: ${b.reply.length > 120 ? `${b.reply.slice(0, 117)}…` : b.reply}`],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'support.reply', entity: 'support_ticket', entityId: id }, c);
      return { message: b.close ? `Replied and closed ${t.number}.` : `Replied to ${t.number}.` };
    });
  }
}
