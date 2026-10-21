// Donations (board "Donate"; B9): to an agency, a station or a named officer, from the wallet
// (PIN) or by Paystack. Split by the agency's donation shares. Never changes how fast help arrives.
import { checkDonation, DEFAULT_DONATION_SHARES, donationFee, DONATION_RULES, formatNaira, splitDonation, type DonationShares } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { PAYMENTS, type PaymentsAdapter } from '../adapters/payments';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify, RECEIVING } from '../reports/shared';
import { WithdrawalsService } from '../wallet/withdrawals.service';
import { payFromWallet, replayed, startCharge, walletOf, type PayWith } from './money';

type TargetType = 'agency' | 'station' | 'officer';
const rating = (v: unknown) => (v == null ? null : Number(Number(v).toFixed(1)));

@Injectable()
export class DonationsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  /** Who the person can give to: agencies, their local stations, and officers who helped them. */
  async targets(p: Principal) {
    const agencies = await this.db.query(
      `select a.id, a.name, a.kind,
              (select avg(r.stars) from ratings r join incidents i on i.id = r.incident_id where i.agency_id = a.id) as rating
         from agencies a where a.status = any($1::text[]) order by a.created_at limit 12`,
      [RECEIVING],
    );
    // Stations that handled my reports first, then the ones nearest my home.
    const stations = await this.db.query(
      `with home as (select l.geom from saved_places sp join locations l on l.id = sp.location_id where sp.user_id = $1 and sp.is_home limit 1),
            mine as (select distinct i.station_id from incidents i join incident_reports ir on ir.incident_id = i.id where ir.reporter_id = $1 and i.station_id is not null)
       select s.id, s.name, a.name as agency, s.id in (select station_id from mine) as helped,
              (select avg(r.stars) from ratings r join incidents i on i.id = r.incident_id where i.station_id = s.id) as rating
         from stations s join agencies a on a.id = s.agency_id
         left join locations sl on sl.id = s.location_id
        where s.status = 'active' and a.status = any($2::text[])
        order by s.id in (select station_id from mine) desc,
                 st_distance(coalesce(sl.geom, s.zone::geography), (select geom from home)) nulls last
        limit 4`,
      [p.userId, RECEIVING],
    );
    const officers = await this.db.query(
      `select distinct on (u.officer_id) u.officer_id as id, ou.display_name as name, o.badge_no, s.name as station, i.type, i.closed_at,
              (select avg(r.stars) from ratings r join incident_units x on x.incident_id = r.incident_id where x.officer_id = u.officer_id and x.accepted_at is not null) as rating
         from incident_reports ir join incidents i on i.id = ir.incident_id
         join incident_units u on u.incident_id = i.id and u.accepted_at is not null
         join users ou on ou.id = u.officer_id left join officers o on o.user_id = u.officer_id join stations s on s.id = u.station_id
        where ir.reporter_id = $1 and i.state = 'resolved'
        order by u.officer_id, i.closed_at desc`,
      [p.userId],
    );
    return {
      presetsKobo: DONATION_RULES.presetsKobo,
      platformFeePct: DONATION_RULES.platformFeePct,
      minKobo: DONATION_RULES.minKobo,
      maxKobo: DONATION_RULES.maxKobo,
      agencies: agencies.rows.map((a) => ({ id: a.id, name: a.name, sub: 'Whole agency', rating: rating(a.rating) })),
      stations: stations.rows.map((s) => ({ id: s.id, name: s.name, sub: s.helped ? `${s.agency}, helped you` : `${s.agency}, near your home`, rating: rating(s.rating) })),
      officers: officers.rows
        .sort((a, b) => +new Date(b.closed_at) - +new Date(a.closed_at))
        .slice(0, 6)
        .map((o) => ({ id: o.id, name: o.name, sub: `${o.station}, responded to your ${o.type} report`, rating: rating(o.rating) })),
    };
  }

  private async resolveTarget(c: Queryable, type: TargetType, id: string) {
    if (type === 'agency') {
      const a = (await c.query(`select id, name from agencies where id = $1 and status = any($2::text[])`, [id, RECEIVING])).rows[0];
      return a ? { type, id, agencyId: a.id as string, name: a.name as string } : null;
    }
    if (type === 'station') {
      const s = (await c.query(`select s.id, s.name, s.agency_id from stations s where s.id = $1 and s.status = 'active'`, [id])).rows[0];
      return s ? { type, id, agencyId: s.agency_id as string, stationId: s.id as string, name: s.name as string } : null;
    }
    const o = (await c.query(`select o.user_id, u.display_name, s.agency_id, s.id as station_id from officers o join users u on u.id = o.user_id join stations s on s.id = o.station_id where o.user_id = $1`, [id])).rows[0];
    return o ? { type, id, agencyId: o.agency_id as string, stationId: o.station_id as string, name: o.display_name as string } : null;
  }

  async give(p: Principal, b: { targetType: TargetType; targetId: string; amountKobo: number; method: PayWith; showName: boolean; pin?: string }, key: string) {
    const prior = await replayed(this.db.pool, key, p.userId);
    if (prior) return prior;
    const bad = checkDonation(b.amountKobo);
    if (bad) throw new AppError(422, 'validation_failed', bad, { fields: [{ field: 'amountKobo', message: bad }] });
    const target = await this.resolveTarget(this.db.pool, b.targetType, b.targetId);
    if (!target) throw new AppError(422, 'target_not_found', 'Choose who to support.');
    if (b.targetType === 'officer' && b.targetId === p.userId) throw new AppError(422, 'validation_failed', 'You cannot donate to yourself.');

    if (b.method !== 'wallet') {
      const d = await this.db.query(
        `insert into donations (donor_id, target_type, target_id, amount_kobo, show_name, method) values ($1, $2, $3, $4, $5, $6) returning id`,
        [p.userId, b.targetType, b.targetId, b.amountKobo, b.showName, b.method],
      );
      const charge = await startCharge(this.db, this.payments, { userId: p.userId, purpose: 'donation', purposeRef: d.rows[0].id, amountKobo: b.amountKobo, method: b.method, key });
      return { ...charge, donationId: d.rows[0].id };
    }
    if (!b.pin) throw new AppError(422, 'pin_required', 'Enter your PIN to pay from your wallet.', { fields: [{ field: 'pin', message: 'Enter your PIN.' }] });
    await this.withdrawals.verifyPin(p.userId, b.pin);
    return this.db.tx(async (c) => {
      const d = await c.query(
        `insert into donations (donor_id, target_type, target_id, amount_kobo, show_name, method) values ($1, $2, $3, $4, $5, 'wallet') returning id`,
        [p.userId, b.targetType, b.targetId, b.amountKobo, b.showName],
      );
      const paid = await payFromWallet(c, { userId: p.userId, purpose: 'donation', purposeRef: d.rows[0].id, amountKobo: b.amountKobo, key, ledgerType: 'donation_out', memo: `Donation to ${target.name}` });
      await c.query(`update donations set payment_id = $2 where id = $1`, [d.rows[0].id, paid.paymentId]);
      await creditDonation(c, d.rows[0].id, paid.reference, paid.journal);
      await this.audit.write({ actorId: p.userId, action: 'donation.paid', entity: 'donation', entityId: d.rows[0].id, payload: { amountKobo: b.amountKobo, method: 'wallet' } }, c);
      return { state: 'succeeded', reference: paid.reference, receiptNo: paid.receiptNo, message: `Thank you. ${formatNaira(b.amountKobo - donationFee(b.amountKobo))} of your ${formatNaira(b.amountKobo)} went to ${target.name}.` };
    });
  }

  async mine(p: Principal) {
    const r = await this.db.query(
      `select d.id, d.target_type, d.amount_kobo, d.state, d.created_at, d.paid_at, py.receipt_no, py.provider_ref,
              coalesce(a.name, s.name, u.display_name) as target
         from donations d left join payments py on py.id = d.payment_id
         left join agencies a on d.target_type = 'agency' and a.id = d.target_id
         left join stations s on d.target_type = 'station' and s.id = d.target_id
         left join users u on d.target_type = 'officer' and u.id = d.target_id
        where d.donor_id = $1 and d.state <> 'failed' order by d.created_at desc limit 50`,
      [p.userId],
    );
    return r.rows.map((d) => ({ id: d.id, target: d.target, targetType: d.target_type, amountKobo: Number(d.amount_kobo), state: d.state, at: d.paid_at ?? d.created_at, receiptNo: d.receipt_no, reference: d.provider_ref }));
  }
}

/**
 * Credits the donation's legs (officers held like rewards; station and agency wallets) and tells
 * the receivers. `reference`/`journal` tie the legs to the debit already written for this payment.
 */
export async function creditDonation(c: Queryable, donationId: string, reference: string, journal: string) {
  const d = (await c.query(`select d.*, u.display_name as donor from donations d join users u on u.id = d.donor_id where d.id = $1 for update of d`, [donationId])).rows[0];
  if (!d || d.state === 'paid') return;
  let agencyId: string;
  let stationId: string | undefined;
  if (d.target_type === 'agency') agencyId = d.target_id;
  else if (d.target_type === 'station') {
    const s = (await c.query(`select agency_id from stations where id = $1`, [d.target_id])).rows[0];
    agencyId = s.agency_id;
    stationId = d.target_id;
  } else {
    const o = (await c.query(`select s.agency_id, s.id from officers o join stations s on s.id = o.station_id where o.user_id = $1`, [d.target_id])).rows[0];
    agencyId = o.agency_id;
    stationId = o.id;
  }
  const sh = (await c.query(`select officer_pct, station_pct, agency_pct from payout_shares where agency_id = $1`, [agencyId])).rows[0];
  const shares: DonationShares = sh ? { officerPct: Number(sh.officer_pct), stationPct: Number(sh.station_pct), agencyPct: Number(sh.agency_pct) } : DEFAULT_DONATION_SHARES;
  const officers =
    d.target_type === 'station'
      ? (await c.query(`select user_id from officers where station_id = $1 and badge_status = 'verified' order by user_id`, [d.target_id])).rows.map((r) => r.user_id as string)
      : [];
  const legs = splitDonation(Number(d.amount_kobo), { type: d.target_type, id: d.target_id, agencyId, stationId }, shares, officers);
  const memo = `Donation${d.show_name ? ` from ${d.donor}` : ''}`;
  for (const l of legs) {
    const wallet =
      l.to === 'platform_fees'
        ? (await c.query(`select id from wallets where owner_type = 'platform_fees' and owner_id is null`)).rows[0].id
        : await walletOf(c, l.to === 'officer' ? 'user' : l.to, l.id);
    await c.query(
      `insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo, available_at)
       values ($1, 'donation_in', $2, $3, $4, $5, case when $6 then now() + make_interval(days => $7) else now() end)`,
      [wallet, l.kobo, reference, journal, l.to === 'platform_fees' ? 'Donation platform fee' : memo, l.to === 'officer', DONATION_RULES.holdDays],
    );
  }
  await c.query(`update donations set state = 'paid', paid_at = now(), shares = $2 where id = $1`, [donationId, JSON.stringify(legs)]);
  const officerIds = legs.filter((l) => l.to === 'officer').map((l) => l.id as string);
  for (const id of officerIds) {
    const leg = legs.find((l) => l.id === id)!;
    await notify(c, [id], {
      type: 'donation_received',
      grp: 'money',
      title: 'Donation received',
      body: `${d.show_name ? d.donor : 'A citizen'} gave ${formatNaira(leg.kobo)}${d.target_type === 'station' ? ' to your station; this is your share' : ''}. Released in ${DONATION_RULES.holdDays} days.`,
      link: '/wallet',
    });
  }
  await notify(c, [d.donor_id], { type: 'donation_paid', grp: 'money', title: 'Thank you', body: `Your donation of ${formatNaira(Number(d.amount_kobo))} was received. Your receipt is in Payments and receipts.`, link: '/payments' });
}
