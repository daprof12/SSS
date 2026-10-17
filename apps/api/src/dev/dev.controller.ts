// Dev-only endpoints. The module is registered only when config.devTools is
// true, which loadConfig() refuses in production.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
    return { token: await this.tokens.sign({ userId: b.userId, sessionId: randomUUID(), roles, mfa: b.mfa }, 8 * 3600) };
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
      return { users: ids, agencyId: agency, stationId: station };
    });
  }

  /** Simulates the customer finishing Paystack checkout; posts a signed webhook to ourselves. */
  @Post('paystack/complete/:reference')
  async complete(@Param('reference') ref: string, @Query('outcome') outcome: 'success' | 'failed' = 'success', @Query('amount') amount?: string) {
    if (!(this.payments instanceof MockPaystackAdapter)) throw new AppError(400, 'not_mock', 'Only with the mock Paystack adapter.');
    const { body, signature } = this.payments.buildWebhook(ref, outcome, amount ? Number(amount) : undefined);
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
