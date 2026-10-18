// Time-based rules nobody presses a button for. Each run is idempotent: rows are
// picked with "for update skip locked" so two API instances never double-apply.
import { applyEvent, FIX_SILENCE_DAYS, formatNaira, issueCategory, issueMachine, tipMachine } from '@erp/domain';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/db';
import { notify } from '../reports/shared';
import { WithdrawalsService } from '../wallet/withdrawals.service';

const EVERY_MS = 5 * 60 * 1000;

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(WithdrawalsService) private readonly withdrawals: WithdrawalsService,
  ) {}

  onModuleInit() {
    // Tests run jobs on demand; everywhere else they tick in-process.
    if (this.config.env === 'test') return;
    this.timer = setInterval(() => this.runAll().catch((e) => this.log.error(e)), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll() {
    return { fixSilence: await this.fixSilence(), bountyRelease: await this.bountyRelease(), withdrawalsReleased: await this.withdrawals.releaseHeld() };
  }

  /** Public issues: no reporter said "not fixed" within FIX_SILENCE_DAYS of the fix, so it is fixed. */
  async fixSilence(): Promise<number> {
    return this.db.tx(async (c) => {
      const due = await c.query(
        `select k.id, k.category from issue_cases k
          where k.state = 'awaiting_check'
            and (select max(at) from issue_events e where e.case_id = k.id and e.kind = 'mark_fixed') <= now() - make_interval(days => $1)
          for update skip locked`,
        [FIX_SILENCE_DAYS],
      );
      for (const k of due.rows) {
        const r = applyEvent(issueMachine, 'awaiting_check', 'confirm_fixed', 'system');
        if (!r.ok) continue;
        await c.query(`update issue_cases set state = $2, fixed_at = now(), updated_at = now() where id = $1`, [k.id, r.to]);
        await c.query(`insert into issue_events (case_id, kind, actor_kind, payload) values ($1, 'confirm_fixed', 'system', $2)`, [k.id, { by: 'silence', days: FIX_SILENCE_DAYS }]);
        const label = issueCategory(k.category)?.label.toLowerCase() ?? 'issue';
        const people = (await c.query(`select distinct user_id from issue_reports where case_id = $1`, [k.id])).rows.map((x) => x.user_id);
        await notify(c, people, { type: 'issue_fixed', grp: 'reports', title: 'Marked fixed', body: `No one said the ${label} was still there after ${FIX_SILENCE_DAYS} days, so it is now closed as fixed.`, link: `/issues/${k.id}` });
      }
      return due.rowCount ?? 0;
    });
  }

  /** Tips: the bounty hold has passed, so the money is now the tipper's to withdraw. */
  async bountyRelease(): Promise<number> {
    return this.db.tx(async (c) => {
      const due = await c.query(
        `select t.id, t.user_id, (select approved_kobo from tip_claims where tip_id = t.id) as approved_kobo from tips t
          where t.state = 'approved_held'
            and exists (select 1 from wallet_ledger l where l.reference = 'tip:' || t.id and l.type = 'bounty' and l.amount_kobo > 0)
            and not exists (select 1 from wallet_ledger l where l.reference = 'tip:' || t.id and l.type = 'bounty' and l.amount_kobo > 0 and l.available_at > now())
          for update of t skip locked`,
      );
      for (const t of due.rows) {
        const r = applyEvent(tipMachine, 'approved_held', 'hold_ends', 'system');
        if (!r.ok) continue;
        await c.query(`update tips set state = $2 where id = $1`, [t.id, r.to]);
        await c.query(`insert into tip_events (tip_id, kind, actor_kind, payload) values ($1, 'hold_ends', 'system', '{}')`, [t.id]);
        const amount = t.approved_kobo ? `${formatNaira(Number(t.approved_kobo))} is` : 'Your bounty is';
        await notify(c, [t.user_id], { type: 'bounty_available', grp: 'tips', title: 'Bounty ready', body: `${amount} now in your wallet and ready to withdraw.`, link: `/tips/${t.id}` });
      }
      return due.rowCount ?? 0;
    });
  }
}
