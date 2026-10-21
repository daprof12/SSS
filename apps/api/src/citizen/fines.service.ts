// B8 False alarm → fine → appeal. Warnings come first and are records, not fines; joiners are
// never fined; a fine never delays a later report.
import { applyEvent, checkAppeal, falseAlarmOutcome, fineMachine, FINE_POLICY, formatNaira, splitFine, trustBand } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PAYMENTS, type PaymentsAdapter } from '../adapters/payments';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';
import { WithdrawalsService } from '../wallet/withdrawals.service';
import { payFromWallet, replayed, startCharge, walletOf, type PayWith } from './money';

const STATE_LABEL: Record<string, string> = { open: 'Open', appealed: 'Appealed', waived: 'Waived', reduced: 'Reduced', upheld: 'Upheld', paid: 'Paid' };
const date = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

@Injectable()
export class FinesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(PAYMENTS) private readonly payments: PaymentsAdapter,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  /**
   * B8 step 1: an officer closed a report as a false alarm. Nothing reaches the reporter yet: the
   * station head confirms or overturns it (decided 2026-10-21), and silence for 48 hours confirms it.
   */
  async onUnfounded(incidentId: string): Promise<void> {
    await this.db
      .tx(async (c) => {
        const i = (await c.query(`select i.station_id, i.type, l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [incidentId])).rows[0];
        await c.query(`update false_alarm_cases set review_due_at = now() + make_interval(hours => $2) where incident_id = $1 and review_state = 'pending'`, [incidentId, FINE_POLICY.reviewHours]);
        if (!i?.station_id) return;
        const heads = (await c.query(`select user_id from user_roles where scope_type = 'station' and scope_id = $1 and role in ('head', 'dispatcher')`, [i.station_id])).rows.map((x) => x.user_id);
        await notify(c, heads, {
          type: 'false_alarm_review',
          grp: 'dispatch',
          title: 'Confirm a false alarm',
          body: `${cap(i.type)} at ${i.postcode ?? 'GPS location'} was closed as a false alarm. Confirm or overturn it within ${FINE_POLICY.reviewHours} hours; after that it goes ahead.`,
          link: `/incidents/${incidentId}`,
        });
      })
      .catch(() => undefined);
  }

  /** The station head confirms (warning or fine follows) or overturns (nothing happens to the reporter). */
  async review(p: Principal, incidentId: string, b: { decision: 'confirm' | 'overturn'; note?: string }) {
    return this.db.tx(async (c) => {
      const k = (
        await c.query(
          `select f.*, i.station_id from false_alarm_cases f join incidents i on i.id = f.incident_id where f.incident_id = $1 for update of f`,
          [incidentId],
        )
      ).rows[0];
      if (!k || !(hasRole(p, 'head', k.station_id) || hasRole(p, 'dispatcher', k.station_id))) throw new AppError(404, 'not_found', 'Nothing to review here.');
      if (k.review_state !== 'pending') throw new AppError(409, 'already_reviewed', 'This false alarm was already reviewed.');
      if (b.decision === 'overturn' && (b.note?.trim().length ?? 0) < 5) {
        throw new AppError(422, 'validation_failed', 'Say why it was not a false alarm.', { fields: [{ field: 'note', message: 'Say why.' }] });
      }
      await c.query(`update false_alarm_cases set review_state = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where incident_id = $1`, [
        incidentId,
        b.decision === 'confirm' ? 'confirmed' : 'overturned',
        p.userId,
        b.note?.trim() || null,
      ]);
      await c.query(`insert into incident_events (incident_id, actor_id, actor_kind, kind, payload, public) values ($1, $2, 'station', $3, $4, false)`, [
        incidentId,
        p.userId,
        b.decision === 'confirm' ? 'false_alarm_confirmed' : 'false_alarm_overturned',
        { label: b.decision === 'confirm' ? 'False alarm confirmed by the station' : `False alarm overturned: ${b.note?.trim()}` },
      ]);
      if (b.decision === 'confirm') await this.issue(c, incidentId);
      await this.audit.write({ actorId: p.userId, actorRole: 'head', action: `false_alarm.${b.decision}`, entity: 'incident', entityId: incidentId, payload: { note: b.note } }, c);
      return { message: b.decision === 'confirm' ? 'Confirmed. The reporter gets a warning or a fine, and can appeal.' : 'Overturned. Nothing is recorded against the reporter.' };
    });
  }

  /** Job: reviews nobody answered within 48 hours go ahead. */
  async autoConfirm(): Promise<number> {
    return this.db.tx(async (c) => {
      const due = await c.query(`select incident_id from false_alarm_cases where review_state = 'pending' and review_due_at <= now() for update skip locked`);
      for (const k of due.rows) {
        await c.query(`update false_alarm_cases set review_state = 'auto_confirmed', reviewed_at = now() where incident_id = $1`, [k.incident_id]);
        await this.issue(c, k.incident_id);
      }
      return due.rowCount ?? 0;
    });
  }

  /** The station's review queue (Reports page, incident detail). */
  async pendingReviews(p: Principal) {
    const stations = p.roles.filter((r) => r.role === 'head' || r.role === 'dispatcher').map((r) => r.scopeId);
    if (!stations.length) throw new AppError(403, 'forbidden', 'For station heads and dispatchers.');
    const r = await this.db.query(
      `select f.incident_id, f.verdict, f.evidence, f.review_due_at, f.decided_at, i.type, l.postcode, u.display_name as officer
         from false_alarm_cases f join incidents i on i.id = f.incident_id left join locations l on l.id = i.location_id join users u on u.id = f.decided_by
        where f.review_state = 'pending' and i.station_id = any($1::uuid[]) order by f.review_due_at`,
      [stations],
    );
    return r.rows.map((x) => ({
      incidentId: x.incident_id,
      label: `${cap(x.type)}, ${x.postcode ?? 'GPS location'}`,
      verdict: x.verdict,
      officer: x.officer,
      officerNote: x.evidence?.note ?? null,
      closedAt: x.decided_at,
      dueAt: x.review_due_at,
    }));
  }

  /** B8 step 2, after the station confirmed (or did not answer in time): warning first, then a fine. */
  private async issue(c: Queryable, incidentId: string): Promise<void> {
    {
      const i = (await c.query(`select i.reporter_id, i.type, i.agency_id, l.postcode from incidents i left join locations l on l.id = i.location_id where i.id = $1`, [incidentId])).rows[0];
      if (!i?.reporter_id) return;
      const done = await c.query(`select 1 from fines where incident_id = $1 union all select 1 from false_alarm_warnings where incident_id = $1`, [incidentId]);
      if (done.rowCount) return;
      const prior = (
        await c.query(
          `select (select count(*) from false_alarm_warnings where user_id = $1 and created_at > now() - make_interval(days => $2))
                + (select count(*) from fines where user_id = $1 and created_at > now() - make_interval(days => $2) and state <> 'waived') as n`,
          [i.reporter_id, FINE_POLICY.windowDays],
        )
      ).rows[0].n;
      const outcome = falseAlarmOutcome(Number(prior));
      const what = `${cap(i.type)}, ${i.postcode ?? 'GPS location'}`;
      await this.adjustTrust(c, i.reporter_id, outcome.trustDelta);
      if (outcome.kind === 'warning') {
        await c.query(`insert into false_alarm_warnings (user_id, incident_id) values ($1, $2)`, [i.reporter_id, incidentId]);
        await notify(c, [i.reporter_id], {
          type: 'false_alarm_warning',
          grp: 'account',
          title: 'Warning: false alarm',
          body: `Your report ${what} was marked a false alarm. This is a warning, not a fine. Another false alarm in ${FINE_POLICY.windowDays / 30} months may lead to a fine.`,
          link: `/reports/${incidentId}`,
        });
        return;
      }
      const number = await this.fineNo(c);
      const f = await c.query(
        `insert into fines (user_id, incident_id, amount_kobo, due_kobo, appeal_by, number, trust_delta, agency_id)
         values ($1, $2, $3, $3, now() + make_interval(days => $4), $5, $6, $7) returning id, appeal_by`,
        [i.reporter_id, incidentId, outcome.amountKobo, FINE_POLICY.appealDays, number, outcome.trustDelta, i.agency_id],
      );
      await notify(c, [i.reporter_id], {
        type: 'fine_issued',
        grp: 'money',
        title: 'Fine issued',
        body: `Your report ${what} was marked a false alarm. The fine is ${formatNaira(outcome.amountKobo)}. You can appeal within ${FINE_POLICY.appealDays} days.`,
        link: `/fines/${f.rows[0].id}`,
      });
      await this.audit.write({ actorId: null, actorRole: 'system', action: 'fine.issued', entity: 'fine', entityId: f.rows[0].id, payload: { incidentId, amountKobo: outcome.amountKobo } }, c);
    }
  }

  private async fineNo(c: Queryable): Promise<string> {
    for (;;) {
      const no = `F-${randomInt(100000, 1000000)}`;
      if (!(await c.query(`select 1 from fines where number = $1`, [no])).rowCount) return no;
    }
  }

  private async adjustTrust(c: Queryable, userId: string, delta: number) {
    const r = await c.query(
      `insert into trust_scores (user_id, score) values ($1, greatest(0, least(100, 70 + $2)))
       on conflict (user_id) do update set score = greatest(0, least(100, trust_scores.score + $2)), updated_at = now() returning score`,
      [userId, delta],
    );
    await c.query(`update trust_scores set band = $2 where user_id = $1`, [userId, trustBand(r.rows[0].score)]);
  }

  private view(f: Record<string, any>) {
    const due = Number(f.due_kobo ?? f.amount_kobo);
    const canAppeal = f.state === 'open' && new Date(f.appeal_by) > new Date();
    return {
      id: f.id,
      number: f.number,
      state: f.state,
      stateLabel: STATE_LABEL[f.state],
      amountKobo: Number(f.amount_kobo),
      dueKobo: due,
      report: f.incident_id ? { id: f.incident_id, label: `${cap(f.type ?? 'report')}, ${f.postcode ?? 'GPS location'}, ${date(f.incident_at)}` } : null,
      reason: f.reason,
      trustDelta: f.trust_delta,
      appealBy: f.appeal_by,
      canAppeal,
      canPay: ['open', 'reduced', 'upheld'].includes(f.state),
      appeal: f.appeal_reason ? { reason: f.appeal_reason, note: f.appeal_note, at: f.appealed_at } : null,
      decision: f.decided_at ? { reason: f.decision_reason, at: f.decided_at } : null,
      paidAt: f.paid_at,
      banner:
        f.state === 'open'
          ? { tone: 'warning', title: 'Your report was marked a false alarm', line: `Fine ${formatNaira(due)}. Appeal within ${FINE_POLICY.appealDays} days or it is due on ${date(f.appeal_by)}.` }
          : f.state === 'appealed'
            ? { tone: 'info', title: 'Appeal sent', line: 'The platform team reviews it and tells you the decision. Nothing is due while it is reviewed.' }
            : f.state === 'reduced'
              ? { tone: 'warning', title: 'Fine reduced', line: `Now ${formatNaira(due)}. ${f.decision_reason ?? ''}`.trim() }
              : f.state === 'upheld'
                ? { tone: 'warning', title: 'Appeal not accepted', line: `${f.decision_reason ?? ''} The fine of ${formatNaira(due)} is due.`.trim() }
                : f.state === 'waived'
                  ? { tone: 'success', title: 'Fine waived', line: `Nothing to pay, and your trust score was restored. ${f.decision_reason ?? ''}`.trim() }
                  : { tone: 'success', title: 'Paid', line: `Paid on ${date(f.paid_at)}. Thank you.` },
    };
  }

  private readonly SELECT = `select f.*, i.type, i.created_at as incident_at, l.postcode from fines f
      left join incidents i on i.id = f.incident_id left join locations l on l.id = i.location_id`;

  async mine(p: Principal) {
    const r = await this.db.query(`${this.SELECT} where f.user_id = $1 order by f.created_at desc`, [p.userId]);
    const warnings = await this.db.query(
      `select w.created_at, i.type, l.postcode from false_alarm_warnings w join incidents i on i.id = w.incident_id left join locations l on l.id = i.location_id where w.user_id = $1 order by w.created_at desc limit 10`,
      [p.userId],
    );
    const trust = (await this.db.query(`select score, band from trust_scores where user_id = $1`, [p.userId])).rows[0] ?? { score: 70, band: 'normal' };
    return {
      trust,
      fines: r.rows.map((f) => this.view(f)),
      warnings: warnings.rows.map((w) => ({ label: `${cap(w.type)}, ${w.postcode ?? 'GPS location'}`, at: w.created_at })),
      policy: { warningsBeforeFine: FINE_POLICY.warningsBeforeFine, amountKobo: FINE_POLICY.amountKobo, appealDays: FINE_POLICY.appealDays, windowDays: FINE_POLICY.windowDays },
    };
  }

  private async own(p: Principal, id: string, c: Queryable = this.db.pool, lock = false) {
    const f = (await c.query(`${this.SELECT} where f.id = $1 and f.user_id = $2${lock ? ' for update of f' : ''}`, [id, p.userId])).rows[0];
    if (!f) throw new AppError(404, 'not_found', 'This fine could not be found.');
    return f;
  }

  async one(p: Principal, id: string) {
    return this.view(await this.own(p, id));
  }

  async appeal(p: Principal, id: string, b: { reason: string; note?: string }) {
    const bad = checkAppeal(b.reason);
    if (bad) throw new AppError(422, 'validation_failed', bad, { fields: [{ field: 'reason', message: bad }] });
    return this.db.tx(async (c) => {
      const f = await this.own(p, id, c, true);
      if (f.state !== 'open') throw new AppError(409, 'not_open', f.state === 'appealed' ? 'You already appealed this fine.' : 'This fine can no longer be appealed.');
      if (new Date(f.appeal_by) < new Date()) throw new AppError(409, 'appeal_closed', `The appeal window closed on ${date(f.appeal_by)}. You can still pay it.`);
      const r = applyEvent(fineMachine, f.state, 'appeal', 'citizen');
      if (!r.ok) throw new AppError(409, r.code, r.message);
      await c.query(`update fines set state = 'appealed', appeal_reason = $2, appeal_note = $3, appealed_at = now() where id = $1`, [id, b.reason.trim(), b.note?.trim() || null]);
      const admins = (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id);
      await notify(c, admins, { type: 'fine_appealed', grp: 'account', title: 'Fine appealed', body: `Fine ${f.number} was appealed. Review it in Fines and appeals.`, link: `/admin/fines` });
      await this.audit.write({ actorId: p.userId, action: 'fine.appeal', entity: 'fine', entityId: id }, c);
      return { ...this.view({ ...f, state: 'appealed', appeal_reason: b.reason.trim(), appealed_at: new Date() }), message: 'Appeal sent. We will tell you the decision.' };
    });
  }

  /** Pay a fine from the wallet (PIN) or by Paystack. Not while an appeal is open. */
  async pay(p: Principal, id: string, b: { method: PayWith; pin?: string }, key: string) {
    const prior = await replayed(this.db.pool, key, p.userId);
    if (prior) return prior;
    const f = await this.own(p, id);
    const r = applyEvent(fineMachine, f.state, 'pay', 'citizen');
    if (!r.ok) throw new AppError(409, 'cannot_pay', f.state === 'appealed' ? 'Wait for the appeal decision before paying.' : 'This fine has nothing to pay.');
    const due = Number(f.due_kobo ?? f.amount_kobo);
    if (b.method !== 'wallet') {
      return startCharge(this.db, this.payments, { userId: p.userId, purpose: 'fine', purposeRef: id, amountKobo: due, method: b.method, key });
    }
    if (!b.pin) throw new AppError(422, 'pin_required', 'Enter your PIN to pay from your wallet.', { fields: [{ field: 'pin', message: 'Enter your PIN.' }] });
    await this.withdrawals.verifyPin(p.userId, b.pin);
    return this.db.tx(async (c) => {
      const cur = await this.own(p, id, c, true);
      if (!['open', 'reduced', 'upheld'].includes(cur.state)) throw new AppError(409, 'cannot_pay', 'This fine has nothing to pay.');
      const paid = await payFromWallet(c, { userId: p.userId, purpose: 'fine', purposeRef: id, amountKobo: due, key, ledgerType: 'fine', memo: `Fine ${cur.number}` });
      await markPaid(c, id, paid.paymentId, paid.reference, paid.journal);
      await this.audit.write({ actorId: p.userId, action: 'fine.paid', entity: 'fine', entityId: id, payload: { method: 'wallet', amountKobo: due } }, c);
      return { state: 'succeeded', reference: paid.reference, receiptNo: paid.receiptNo, message: `Paid ${formatNaira(due)}. Your receipt is in Payments and receipts.` };
    });
  }

  // ---------------------------------------------------------------- platform admin (B8 step 4)

  private admin(p: Principal) {
    if (!hasRole(p, 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }

  async queue(p: Principal, state: string) {
    this.admin(p);
    const r = await this.db.query(
      `${this.SELECT.replace('select f.*', 'select f.*, u.display_name as citizen, coalesce(t.score, 70) as trust')}
         join users u on u.id = f.user_id left join trust_scores t on t.user_id = f.user_id
        where ($1 = 'all' or f.state = $1) order by f.state = 'appealed' desc, f.created_at desc limit 100`,
      [state],
    );
    const counts = (await this.db.query(`select state, count(*)::int as n from fines group by state`)).rows;
    return {
      counts: Object.fromEntries(counts.map((x) => [x.state, x.n])),
      items: r.rows.map((f) => ({ ...this.view(f), citizen: f.citizen, trust: Number(f.trust), evidence: null as unknown })),
    };
  }

  async decide(p: Principal, id: string, b: { decision: 'waive' | 'reduce' | 'uphold'; reason: string; amountKobo?: number }) {
    this.admin(p);
    if (b.reason.trim().length < 5) throw new AppError(422, 'validation_failed', 'Give a reason the citizen will read.', { fields: [{ field: 'reason', message: 'Give a reason.' }] });
    return this.db.tx(async (c) => {
      const f = (await c.query(`select * from fines where id = $1 for update`, [id])).rows[0];
      if (!f) throw new AppError(404, 'not_found', 'Fine not found.');
      const r = applyEvent(fineMachine, f.state, b.decision, 'platform_admin');
      if (!r.ok) throw new AppError(409, r.code, 'This fine cannot take that decision now.');
      let due = Number(f.due_kobo ?? f.amount_kobo);
      if (b.decision === 'reduce') {
        if (!b.amountKobo || b.amountKobo <= 0 || b.amountKobo >= Number(f.amount_kobo)) {
          throw new AppError(422, 'validation_failed', `Enter an amount below ${formatNaira(Number(f.amount_kobo))}.`, { fields: [{ field: 'amountKobo', message: 'Enter a lower amount.' }] });
        }
        due = b.amountKobo;
      }
      await c.query(`update fines set state = $2, due_kobo = $3, decided_by = $4, decided_at = now(), decision_reason = $5 where id = $1`, [id, r.to, due, p.userId, b.reason.trim()]);
      // A waived fine was a mistake: give the trust points back.
      if (b.decision === 'waive') await this.adjustTrust(c, f.user_id, -f.trust_delta);
      const body =
        b.decision === 'waive'
          ? `Fine ${f.number} was waived. Nothing to pay. ${b.reason.trim()}`
          : b.decision === 'reduce'
            ? `Fine ${f.number} was reduced to ${formatNaira(due)}. ${b.reason.trim()}`
            : `Your appeal for fine ${f.number} was not accepted. ${b.reason.trim()}`;
      await notify(c, [f.user_id], { type: 'fine_decided', grp: 'money', title: 'Appeal decided', body, link: `/fines/${id}` });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: `fine.${b.decision}`, entity: 'fine', entityId: id, payload: { reason: b.reason, dueKobo: due } }, c);
      return { state: r.to, message: b.decision === 'waive' ? 'Fine waived.' : b.decision === 'reduce' ? `Reduced to ${formatNaira(due)}.` : 'Fine upheld.' };
    });
  }
}

/**
 * Marks the fine paid and shares the money (decided 2026-10-21): 40% to the agency whose station
 * handled the report, 30% to the rewards pool, 30% to the platform. The debit leg (the person's wallet,
 * or the platform wallet as the contra for money in from Paystack) is already written under `journal`.
 */
export async function markPaid(c: Queryable, fineId: string, paymentId: string, reference: string, journal: string) {
  const f = (
    await c.query(
      `update fines set state = 'paid', paid_at = now(), payment_id = $2 where id = $1 and state in ('open', 'reduced', 'upheld') returning user_id, number, due_kobo, amount_kobo, agency_id`,
      [fineId, paymentId],
    )
  ).rows[0];
  if (!f) return;
  const total = Number(f.due_kobo ?? f.amount_kobo);
  const parts = splitFine(total, !!f.agency_id);
  const legs: { wallet: string; kobo: number; to: string }[] = [];
  if (parts.agency) legs.push({ wallet: await walletOf(c, 'agency', f.agency_id), kobo: parts.agency, to: 'agency' });
  if (parts.pool) legs.push({ wallet: (await c.query(`select id from wallets where owner_type = 'rewards_pool' and owner_id is null`)).rows[0].id, kobo: parts.pool, to: 'rewards_pool' });
  if (parts.platform) legs.push({ wallet: (await c.query(`select id from wallets where owner_type = 'platform_fees' and owner_id is null`)).rows[0].id, kobo: parts.platform, to: 'platform' });
  for (const l of legs) {
    await c.query(`insert into wallet_ledger (wallet_id, type, amount_kobo, reference, journal_id, memo) values ($1, 'fine', $2, $3, $4, $5)`, [l.wallet, l.kobo, reference, journal, `Fine ${f.number}`]);
  }
  await c.query(`update fines set shares = $2 where id = $1`, [fineId, JSON.stringify(legs.map(({ to, kobo }) => ({ to, kobo })))]);
  await notify(c, [f.user_id], { type: 'fine_paid', grp: 'money', title: 'Fine paid', body: `Fine ${f.number} is paid: ${formatNaira(Number(f.due_kobo ?? f.amount_kobo))}. Your receipt is in Payments and receipts.`, link: `/fines/${fineId}` });
}
