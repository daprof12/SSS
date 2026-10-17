// The single path for agency state changes (UX Gap Analysis §10): lock the row,
// check the machine, write state + timeline event + audit in one transaction.
import { Inject, Injectable } from '@nestjs/common';
import { agencyHandles, applyEvent, agencyMachine, type AgencyActor, type AgencyEvent, type AgencyState } from '@erp/domain';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';

export interface AgencyRow {
  id: string;
  name: string;
  kind: string;
  status: AgencyState;
  contact_user_id: string | null;
  signatory_name: string | null;
  official_email: string | null;
  /** 'YYYY-MM-DD' */
  period_start: string | null;
  period_end: string | null;
  paystack_subaccount: string | null;
}

export const stateLabels: Record<AgencyState, string> = {
  registering: 'Draft',
  documents_submitted: 'Submitted',
  in_review: 'In review',
  more_info_needed: 'More information needed',
  rejected: 'Not approved',
  approved: 'Approved',
  fee_pending: 'Waiting for payment',
  setting_up: 'Setting up',
  live: 'Live',
  overdue: 'Payment overdue',
  offboarding: 'Leaving',
  offboarded: 'Closed',
};

const NOT_ALLOWED: Partial<Record<AgencyEvent, string>> = {
  submit: 'Your application is under review. You can change it if we ask for more information.',
  choose_plan: 'You can choose a plan once your agency is approved.',
  go_live: 'Finish setting up before going live.',
  request_offboard: 'This agency cannot leave from its current state.',
};

export type Notify = { type: string; grp: 'account' | 'money' | 'team'; title: string; body: string; link?: string };

@Injectable()
export class AgencyLifecycle {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  async lock(c: Queryable, agencyId: string): Promise<AgencyRow> {
    const r = await c.query(`select * from agencies where id = $1 for update`, [agencyId]);
    if (!r.rows[0]) throw new AppError(404, 'not_found', 'Agency not found.');
    return r.rows[0];
  }

  /**
   * Applies one machine event. `set` adds column updates that must land in the same
   * row write (e.g. the billing period, which a check constraint requires once paid).
   */
  async transition(
    c: Queryable,
    agencyId: string,
    event: AgencyEvent,
    actor: AgencyActor,
    actorId: string | null,
    opts: { comment?: string; set?: Record<string, unknown>; payload?: Record<string, unknown> } = {},
  ): Promise<{ from: AgencyState; to: AgencyState; agency: AgencyRow }> {
    const row = await this.lock(c, agencyId);
    const r = applyEvent(agencyMachine, row.status, event, actor);
    if (!r.ok) {
      const status = r.code === 'actor_not_allowed' ? 403 : 409;
      throw new AppError(status, r.code, NOT_ALLOWED[event] ?? `This is not available while the agency is ${stateLabels[row.status].toLowerCase()}.`);
    }
    const set: Record<string, unknown> = { ...(opts.set ?? {}), status: r.to };
    const cols = Object.keys(set);
    const updated = await c.query(
      `update agencies set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`,
      [agencyId, ...cols.map((k) => set[k])],
    );
    await c.query(`insert into agency_events (agency_id, event, from_state, to_state, actor_id, comment) values ($1, $2, $3, $4, $5, $6)`, [
      agencyId,
      event,
      row.status,
      r.to,
      actorId,
      opts.comment ?? null,
    ]);
    await this.audit.write(
      { actorId, actorRole: actor, action: `agency.${event}`, entity: 'agency', entityId: agencyId, reason: opts.comment, payload: { from: row.status, to: r.to, ...(opts.payload ?? {}) } },
      c,
    );
    return { from: row.status, to: r.to, agency: updated.rows[0] };
  }

  /** In-app message to the agency's contact person. */
  async notify(c: Queryable, agency: Pick<AgencyRow, 'id' | 'contact_user_id'>, n: Notify) {
    if (!agency.contact_user_id) return;
    await c.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, $2, $3, 'in_app', $4, $5, $6)`, [
      agency.contact_user_id,
      n.type,
      n.grp,
      n.title,
      n.body,
      n.link ?? `/agency/${agency.id}`,
    ]);
  }

  /**
   * Agency staff check against the database, not the token: the contact person is
   * granted agency_admin at registration, after their token was issued. Unknown → 404.
   */
  async requireStaff(p: Principal, agencyId: string, roles: string[] = ['agency_admin', 'agency_finance']): Promise<void> {
    if (!p.mfa) throw new AppError(403, 'mfa_required', 'Turn on two-step login to continue.');
    const r = await this.db.query(`select 1 from user_roles where user_id = $1 and scope_type = 'agency' and scope_id = $2 and role = any($3::text[])`, [
      p.userId,
      agencyId,
      roles,
    ]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Agency not found.');
  }

  /** Not every agency handles every queue: a fire service takes no tips, NAPTIP no public issues. */
  async requireHandles(agencyId: string, what: 'tips' | 'bounties' | 'issues'): Promise<void> {
    const a = (await this.db.query(`select kind from agencies where id = $1`, [agencyId])).rows[0];
    if (a && agencyHandles(a.kind)[what]) return;
    const message = { tips: 'Your agency does not receive tips.', bounties: 'Your agency does not pay bounties.', issues: 'Your agency does not handle public issues.' }[what];
    throw new AppError(409, 'not_handled', message);
  }

  requirePlatformAdmin(p: Principal): void {
    if (!hasRole(p, 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }
}
