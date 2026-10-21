// Dev-only endpoints. The module is registered only when config.devTools is
// true, which loadConfig() refuses in production.
import { seedLearn } from './learn-seed';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { MockPostcodeAdapter, POSTCODE, type PostcodeAdapter } from '../adapters/postcode';
import { MockPaystackAdapter, PAYMENTS, type PaymentsAdapter } from '../adapters/payments';
import { MockSmsAdapter, SMS, type SmsAdapter } from '../adapters/sms';
import { Public, TokenService, type RoleGrant } from '../core/auth';
import { Db } from '../core/db';
import { AppError, ZodPipe } from '../core/http';
import { WalletService } from '../wallet/wallet.service';

const PEOPLE = [
  { key: 'citizen', phone: '+2348030000001', name: 'Ada Obi', kyc: true },
  { key: 'officer', phone: '+2348030000002', name: 'Insp. Musa Bello', kyc: true },
  { key: 'officer2', phone: '+2348030000003', name: 'Sgt. Bola Ade', kyc: true },
  { key: 'head', phone: '+2348030000004', name: 'CSP Ngozi Eze', kyc: true },
  { key: 'agencyAdmin', phone: '+2348030000005', name: 'Agency Admin', kyc: true },
  { key: 'platformAdmin', phone: '+2348030000006', name: 'Platform Admin', kyc: true },
  { key: 'technician', phone: '+2348030000007', name: 'Tunde Tech', kyc: true },
  { key: 'neighbour', phone: '+2348030000008', name: 'Chidi Neighbour', kyc: true },
] as const;

@Public()
@Controller('dev')
export class DevController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(SMS) private readonly sms: SmsAdapter,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
    @Inject(WalletService) private readonly wallet: WalletService,
  ) {}

  @Post('token')
  async token(@Body(new ZodPipe(z.object({ userId: z.string().uuid(), mfa: z.boolean().default(true) }))) b: { userId: string; mfa: boolean }) {
    const roles = (await this.db.query(`select role, scope_type, scope_id from user_roles where user_id = $1`, [b.userId])).rows.map(
      (r): RoleGrant => ({ role: r.role, scopeType: r.scope_type, scopeId: r.scope_id }),
    );
    // A real session row, so revocation checks apply to demo sign-ins too.
    const sid = (
      await this.db.query(`insert into sessions (user_id, label, platform, mfa_passed, expires_at) values ($1, 'Demo sign-in', 'dev', $2, now() + interval '8 hours') returning id`, [b.userId, b.mfa])
    ).rows[0].id;
    return { token: await this.tokens.sign({ userId: b.userId, sessionId: sid, roles, mfa: b.mfa }, 8 * 3600) };
  }

  /** Idempotent demo data: one live police agency, one station, two on-duty officers and every role. */
  @Post('seed')
  async seed() {
    return this.db.tx(async (c) => {
      const ids: Record<string, string> = {};
      for (const p of PEOPLE) {
        const r = await c.query(
          `insert into users (phone, display_name) values ($1, $2) on conflict (phone) do update set display_name = excluded.display_name returning id`,
          [p.phone, p.name],
        );
        ids[p.key] = r.rows[0].id;
        if (p.kyc) {
          await c.query(
            `insert into kyc_verifications (user_id, provider, provider_ref, id_type, id_masked, selfie_match, liveness, status, verified_at)
             select $1, 'mock', 'seed', 'nin', '•••••••1234', 0.98, true, 'verified', now()
             where not exists (select 1 from kyc_verifications where user_id = $1 and status = 'verified')`,
            [ids[p.key]],
          );
        }
        // The identity check's name: no rank or title (bank accounts are in this name).
        await c.query(`update kyc_verifications set full_name = $2 where user_id = $1 and full_name is null`, [ids[p.key], p.name.replace(/^(Insp\.|Sgt\.|CSP|ACF|FO|Dr\.?|Mr\.?|Mrs\.?)\s+/, '')]);
        await c.query(`insert into trust_scores (user_id, score, band) values ($1, 82, 'high') on conflict do nothing`, [ids[p.key]]);
      }

      const loc = await c.query(
        `insert into locations (postcode, building_name, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
         values ('CD34E', 'Ikeja Division', '34 Allen Avenue', 'LA', 'LA-IKJ', 'LA-IKJ-01', 'LA-IKJ-01-ALN', 'Allen, Ikeja', st_setsrid(st_makepoint(3.3539, 6.6012), 4326)::geography)
         on conflict (postcode) do update set fetched_at = now() returning id`,
      );
      let agency = (await c.query(`select id from agencies where name = 'Nigeria Police Force (demo)'`)).rows[0]?.id;
      if (!agency) {
        agency = (
          await c.query(
            `insert into agencies (name, kind, status, location_id, contact_user_id, period_start, period_end)
             values ('Nigeria Police Force (demo)', 'police', 'live', $1, $2, current_date, current_date + interval '1 month') returning id`,
            [loc.rows[0].id, ids.agencyAdmin],
          )
        ).rows[0].id;
        await c.query(`insert into agency_plan_items (agency_id, code, quantity, starts_on) values ($1, 'agency_base', 1, current_date)`, [agency]);
      }
      let station = (await c.query(`select id from stations where agency_id = $1`, [agency])).rows[0]?.id;
      station ??= (
        await c.query(
          `insert into stations (agency_id, name, location_id, head_user_id, status, accept_window_seconds) values ($1, 'Station 4 Ikeja', $2, $3, 'active', 25) returning id`,
          [agency, loc.rows[0].id, ids.head],
        )
      ).rows[0].id;

      for (const [k, badge, lng, lat] of [
        ['officer', 'B-0477', 3.352, 6.6015],
        ['officer2', 'B-0912', 3.36, 6.61],
      ] as const) {
        await c.query(
          `insert into officers (user_id, station_id, badge_no, rank, badge_status, on_duty, last_location, last_location_at)
           values ($1, $2, $3, 'Inspector', 'verified', true, st_setsrid(st_makepoint($4, $5), 4326)::geography, now())
           on conflict (user_id) do update set on_duty = true, badge_status = 'verified'`,
          [ids[k], station, badge, lng, lat],
        );
      }
      await c.query(`insert into technicians (user_id, vetted_at, vetting_ref) values ($1, now(), 'seed') on conflict do nothing`, [ids.technician]);

      const grants: Array<[string, string, string, string | null]> = [
        [ids.citizen!, 'citizen', 'self', null],
        [ids.neighbour!, 'citizen', 'self', null],
        [ids.officer!, 'officer', 'station', station],
        [ids.officer2!, 'officer', 'station', station],
        [ids.head!, 'head', 'station', station],
        [ids.agencyAdmin!, 'agency_admin', 'agency', agency],
        [ids.platformAdmin!, 'platform_admin', 'platform', null],
        [ids.technician!, 'technician', 'platform', null],
      ];
      for (const [u, role, st, sid] of grants) {
        await c.query(
          `insert into user_roles (user_id, role, scope_type, scope_id) select $1, $2, $3, $4
           where not exists (select 1 from user_roles where user_id = $1 and role = $2 and scope_id is not distinct from $4)`,
          [u, role, st, sid],
        );
      }
      await c.query(`update users set mfa_enabled = true where id = any($1::uuid[])`, [[ids.officer, ids.officer2, ids.head, ids.agencyAdmin, ids.platformAdmin, ids.technician]]);
      await c.query(
        `insert into plans (code, audience, name, price_kobo, install_fee_kobo, interval, devices_included) values
          ('household', 'household', 'Household', 1500000, 7500000, 'month', '{"camera":1,"street_light":1}'),
          ('household_plus', 'household', 'Household Plus', 2500000, 9500000, 'month', '{"camera":2,"street_light":1}'),
          ('community', 'community', 'Community', 9000000, 30000000, 'month', '{"camera":6,"street_light":3}')
         on conflict do nothing`,
      );
      // Saved homes for the two demo citizens, so Home shows a confirmed building.
      for (const [k, pc, addr, area, lat, lng] of [
        ['citizen', 'AB12C', '12 Maple Road', 'Maple area, Ikeja', 6.6018, 3.3515],
        ['neighbour', 'AB12C', '12 Maple Road', 'Maple area, Ikeja', 6.6018, 3.3515],
      ] as const) {
        const l = await c.query(
          `insert into locations (postcode, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
           values ($1, $2, 'LA', 'LA-IKJ', 'LA-IKJ-01', 'LA-IKJ-01-MPL', $3, st_setsrid(st_makepoint($5, $4), 4326)::geography)
           on conflict (postcode) do update set fetched_at = now() returning id`,
          [pc, addr, area, lat, lng],
        );
        await c.query(
          `insert into saved_places (user_id, label, location_id, is_home, verified) select $1, 'Home', $2, true, true
           where not exists (select 1 from saved_places where user_id = $1 and is_home)`,
          [ids[k], l.rows[0].id],
        );
      }
      // Demo receiving agencies for tips (NAPTIP, with a funded bounty pool) and public issues (FERMA, roads).
      const demoAgency = async (name: string, kind: string) => {
        const id =
          (await c.query(`select id from agencies where name = $1`, [name])).rows[0]?.id ??
          (
            await c.query(
              `insert into agencies (name, kind, status, contact_user_id, period_start, period_end) values ($1, $2, 'live', $3, current_date, current_date + interval '1 month') returning id`,
              [name, kind, ids.agencyAdmin],
            )
          ).rows[0].id;
        await c.query(
          `insert into user_roles (user_id, role, scope_type, scope_id) select $1, 'agency_admin', 'agency', $2
           where not exists (select 1 from user_roles where user_id = $1 and role = 'agency_admin' and scope_id = $2)`,
          [ids.agencyAdmin, id],
        );
        return id as string;
      };
      const naptip = await demoAgency('NAPTIP (demo)', 'naptip');
      const ferma = await demoAgency('FERMA (demo)', 'roads');
      await c.query(
        `insert into bounty_rates (agency_id, category, basis, tiers, cap_kobo) values ($1, 'human_trafficking', 'tiered', '{"min": 5000000, "max": 50000000}', 50000000)
         on conflict (agency_id, category) do nothing`,
        [naptip],
      );
      const pool = (
        await c.query(`insert into wallets (owner_type, owner_id) values ('bounty_pool', $1) on conflict (owner_type, owner_id) do update set owner_type = excluded.owner_type returning id`, [naptip])
      ).rows[0].id;
      const funded = (await c.query(`select coalesce(sum(amount_kobo), 0)::bigint as k from wallet_ledger where wallet_id = $1`, [pool])).rows[0].k;
      if (Number(funded) === 0) {
        const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
        const j = (await c.query(`select gen_random_uuid() as j`)).rows[0].j;
        await c.query(
          `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'fund', 200000000, $3, $4, 'Demo pool funding'), ($2, 'fund', -200000000, $3, $4, 'Demo pool funding')`,
          [pool, platform, `seed-pool-${naptip}`, j],
        );
      }
      await seedLearn(c, ids.platformAdmin!, { police: agency, ferma, naptip });
      // Rewards: ₦5,000 for a 5-star police response, and ₦500,000 in the platform rewards pool.
      await c.query(`insert into reward_rules (agency_id, five_star_kobo, four_star_pct, split) values ($1, 500000, 50, 'lead_first') on conflict do nothing`, [agency]);
      const rp = (await c.query(`select w.id, coalesce(sum(l.amount_kobo), 0)::bigint as k from wallets w left join wallet_ledger l on l.wallet_id = w.id where w.owner_type = 'rewards_pool' and w.owner_id is null group by w.id`)).rows[0];
      if (rp && Number(rp.k) === 0) {
        const platform = (await c.query(`select id from wallets where owner_type = 'platform' and owner_id is null`)).rows[0].id;
        const j = (await c.query(`select gen_random_uuid() as j`)).rows[0].j;
        await c.query(
          `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'fund', 50000000, 'seed-rewards-pool', $3, 'Demo rewards pool'), ($2, 'fund', -50000000, 'seed-rewards-pool', $3, 'Demo rewards pool')`,
          [rp.id, platform, j],
        );
      }
      // Duty roster for the two demo officers: today and the next few days.
      const shifts = (await c.query(`select count(*)::int as n from duty_shifts where officer_id = any($1::uuid[])`, [[ids.officer, ids.officer2]])).rows[0].n;
      if (!shifts) {
        for (const [who, offset, kind, vehicle] of [
          [ids.officer, 0, 'day', 'Patrol 4-1'],
          [ids.officer2, 0, 'day', 'Patrol 4-1'],
          [ids.officer, 1, 'night', 'Patrol 4-2'],
          [ids.officer2, 1, 'off', null],
          [ids.officer, 2, 'off', null],
          [ids.officer2, 2, 'day', 'Patrol 4-1'],
          [ids.officer, 3, 'day', 'Patrol 4-1'],
        ] as const) {
          const start = kind === 'night' ? 19 : 7;
          await c.query(
            `insert into duty_shifts (officer_id, starts_at, ends_at, kind, vehicle_ref)
             values ($1, date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos' + make_interval(days => $2, hours => $3),
                         date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos' + make_interval(days => $2, hours => $3 + 12), $4, $5)`,
            [who, offset, start, kind, vehicle],
          );
        }
      }
      return { users: ids, agencyId: agency, stationId: station, naptipId: naptip, fermaId: ferma };
    });
  }

  /** Simulates the customer finishing Paystack checkout; posts a signed webhook to ourselves. */
  @Post('paystack/complete/:reference')
  async complete(@Param('reference') ref: string, @Query('outcome') outcome: 'success' | 'failed' = 'success', @Query('amount') amount?: string) {
    if (!(this.payments instanceof MockPaystackAdapter)) throw new AppError(400, 'not_mock', 'Only with the mock Paystack adapter.');
    const pay = (await this.db.query(`select amount_kobo, method, purpose, user_id from payments where provider_ref = $1`, [ref])).rows[0];
    if (!pay) throw new AppError(404, 'not_found', 'Payment not found.');
    this.payments.restore({ reference: ref, amountKobo: pay.amount_kobo, method: pay.method ?? 'card', email: '', metadata: { purpose: pay.purpose, userId: pay.user_id } });
    const { body, signature } = this.payments.buildWebhook(ref, outcome, amount ? Number(amount) : undefined);
    return this.wallet.handleWebhook(Buffer.from(body), signature);
  }

  /** Simulates Paystack settling (or failing) a payout transfer; posts a signed transfer.* webhook. */
  @Post('paystack/transfer/:payoutId')
  async settleTransfer(@Param('payoutId') id: string, @Query('outcome') outcome: 'success' | 'failed' = 'success') {
    if (!(this.payments instanceof MockPaystackAdapter)) throw new AppError(400, 'not_mock', 'Only with the mock Paystack adapter.');
    const po = (await this.db.query(`select id, amount_kobo, transfer_code, reason from payouts where id = $1`, [id])).rows[0];
    if (!po?.transfer_code) throw new AppError(404, 'not_found', 'No transfer for this payout.');
    this.payments.restoreTransfer({ reference: `payout:${po.id}`, amountKobo: Number(po.amount_kobo), recipientCode: 'RCP_dev', reason: po.reason ?? 'Agency payout', transferCode: po.transfer_code });
    const { body, signature } = this.payments.buildTransferWebhook(`payout:${po.id}`, outcome);
    return this.wallet.handleWebhook(Buffer.from(body), signature);
  }

  /** Simulates Paystack settling (or failing) a wallet withdrawal transfer. */
  @Post('paystack/withdrawal/:id')
  async settleWithdrawal(@Param('id') id: string, @Query('outcome') outcome: 'success' | 'failed' = 'success') {
    if (!(this.payments instanceof MockPaystackAdapter)) throw new AppError(400, 'not_mock', 'Only with the mock Paystack adapter.');
    const w = (await this.db.query(`select id, amount_kobo, fee_kobo, transfer_code from withdrawals where id = $1`, [id])).rows[0];
    if (!w?.transfer_code) throw new AppError(404, 'not_found', 'No transfer for this withdrawal yet.');
    this.payments.restoreTransfer({ reference: `wd:${w.id}`, amountKobo: Number(w.amount_kobo) - Number(w.fee_kobo), recipientCode: 'RCP_dev', reason: 'Wallet withdrawal', transferCode: w.transfer_code });
    const { body, signature } = this.payments.buildTransferWebhook(`wd:${w.id}`, outcome);
    return this.wallet.handleWebhook(Buffer.from(body), signature);
  }

  /** Mock object storage: accepts the upload a presigned URL points at and discards it. */
  @Put('storage/*key')
  @HttpCode(200)
  upload() {
    return { ok: true };
  }

  @Get('sms')
  outbox() {
    return this.sms instanceof MockSmsAdapter ? this.sms.outbox : [];
  }

  @Post('postcode/down')
  toggle(@Query('down') down: string) {
    if (this.postcode instanceof MockPostcodeAdapter) this.postcode.down = down === '1';
    return { down: down === '1' };
  }
}
