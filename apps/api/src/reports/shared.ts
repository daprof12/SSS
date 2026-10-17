import { randomInt } from 'node:crypto';
import type { Queryable } from '../core/db';

/** Live agencies receive reports; overdue ones too — billing never stops a report reaching them. */
export const RECEIVING = ['live', 'overdue', 'offboarding'];

/** First onboarded agency of the given kinds, in the catalogue's order. */
export async function receivingAgency(c: Queryable, kinds: string[]): Promise<{ id: string; name: string } | null> {
  if (!kinds.length) return null;
  const r = await c.query(
    `select id, name from agencies where kind = any($1::text[]) and status = any($2::text[])
      order by array_position($1::text[], kind), created_at limit 1`,
    [kinds, RECEIVING],
  );
  return r.rows[0] ?? null;
}

/** Short public reference people can read out on the phone, e.g. T-482913. */
export async function publicNo(c: Queryable, table: 'tips' | 'issue_cases', prefix: string): Promise<string> {
  for (;;) {
    const no = `${prefix}-${String(randomInt(100000, 1000000))}`;
    const hit = await c.query(`select 1 from ${table} where public_no = $1`, [no]);
    if (!hit.rowCount) return no;
  }
}

export async function notify(c: Queryable, userIds: string[], n: { type: string; grp: string; title: string; body: string; link: string }) {
  if (!userIds.length) return;
  await c.query(
    `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
     select u, $2, $3, 'in_app', $4, $5, $6 from unnest($1::uuid[]) as u`,
    [userIds, n.type, n.grp, n.title, n.body, n.link],
  );
}

export async function agencyStaff(c: Queryable, agencyId: string): Promise<string[]> {
  const r = await c.query(`select distinct user_id from user_roles where scope_type = 'agency' and scope_id = $1 and role in ('agency_admin', 'agency_finance')`, [agencyId]);
  return r.rows.map((x) => x.user_id);
}
