// Help chat (floating help button): the assistant answers first; a person from the help team can be
// asked for, or step in, at any time. A hand-off opens a help ticket so it shows in the inbox, and
// the person sees the team's replies in the same chat.
import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { agencyHandles, citizenStatus, issueCategories, tipCategories, type IncidentState } from '@erp/domain';
import { ASSISTANT, type AssistantAdapter, type HelpToolKit, type HelpTurn } from '../adapters/assistant';
import { Audit } from '../core/audit';
import { hasRole, requirePerm, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const KIND: Record<string, string> = { police: 'Police', fire: 'Fire service', health: 'Ambulance and health', frsc: 'Road safety', roads: 'Roads', naptip: 'NAPTIP' };
/** Messages a person may send in 10 minutes: enough for a real chat, not for abuse. */
const RATE = 30;

@Injectable()
export class HelpService {
  private readonly log = new Logger('Help');
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(ASSISTANT) private readonly assistant: AssistantAdapter,
  ) {}

  private surface(p: Principal): 'citizen' | 'officer' | 'staff' {
    if (p.roles.some((r) => r.role.startsWith('platform_') || r.role.startsWith('agency_') || r.role === 'head' || r.role === 'dispatcher')) return 'staff';
    return hasRole(p, 'officer') ? 'officer' : 'citizen';
  }

  private async conversation(p: Principal, id: string, c: Queryable = this.db.pool, lock = false) {
    const row = (await c.query(`select * from help_conversations where id = $1 and user_id = $2${lock ? ' for update' : ''}`, [id, p.userId])).rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Chat not found.');
    return row;
  }

  private async messages(id: string, after = 0, staff = false) {
    const r = await this.db.query(
      `select m.id, m.role, m.body, m.sources, m.created_at, u.display_name as author from help_messages m left join users u on u.id = m.author_id
        where m.conversation_id = $1 and m.id > $2 ${staff ? '' : "and m.role <> 'note'"} order by m.id`,
      [id, after],
    );
    return r.rows.map((m) => ({ id: Number(m.id), role: m.role, body: m.body, sources: m.sources, author: m.role === 'agent' ? (m.author ?? 'Help team') : m.role === 'bot' ? 'Assistant' : m.author, at: m.created_at }));
  }

  private present(c: Record<string, any>) {
    return {
      id: c.id,
      state: c.state,
      stateLabel: c.state === 'bot' ? 'Assistant' : c.state === 'waiting_human' ? 'Waiting for a person' : c.state === 'human' ? 'With the help team' : 'Closed',
      handoffReason: c.handoff_reason,
    };
  }

  /** The person's open chat, if any. */
  async current(p: Principal) {
    const c = (await this.db.query(`select * from help_conversations where user_id = $1 and state <> 'closed' order by updated_at desc limit 1`, [p.userId])).rows[0];
    if (!c) return null;
    return { ...this.present(c), messages: await this.messages(c.id) };
  }

  async poll(p: Principal, id: string, after: number) {
    const c = await this.conversation(p, id);
    return { ...this.present(c), messages: await this.messages(id, after) };
  }

  /** Send a message: the assistant replies unless a person has the chat. */
  async send(p: Principal, b: { message: string; conversationId?: string }) {
    const text = b.message.trim();
    if (!text) throw new AppError(422, 'validation_failed', 'Write a message.', { fields: [{ field: 'message', message: 'Write a message.' }] });
    const recent = (await this.db.query(`select count(*)::int as n from help_messages m join help_conversations c on c.id = m.conversation_id where c.user_id = $1 and m.role = 'user' and m.created_at > now() - interval '10 minutes'`, [p.userId])).rows[0].n;
    if (recent >= RATE) throw new AppError(429, 'slow_down', 'You have sent a lot of messages. Wait a few minutes, or ask for a person.');
    let conv = b.conversationId ? await this.conversation(p, b.conversationId) : (await this.db.query(`select * from help_conversations where user_id = $1 and state <> 'closed' order by updated_at desc limit 1`, [p.userId])).rows[0];
    if (!conv || conv.state === 'closed') conv = (await this.db.query(`insert into help_conversations (user_id, surface) values ($1, $2) returning *`, [p.userId, this.surface(p)])).rows[0];
    const userMsg = (await this.db.query(`insert into help_messages (conversation_id, role, author_id, body) values ($1, 'user', $2, $3) returning id`, [conv.id, p.userId, text.slice(0, 4000)])).rows[0].id;
    await this.db.query(`update help_conversations set updated_at = now() where id = $1`, [conv.id]);

    if (conv.state !== 'bot') {
      // A person has it (or is about to): tell them there is something new.
      const to = conv.assigned_to ? [conv.assigned_to] : await this.helpTeam(this.db.pool);
      await notify(this.db.pool, to, { type: 'help_chat_message', grp: 'team', title: 'New message in a help chat', body: text.slice(0, 140), link: `/admin/support?chat=${conv.id}` });
      return { ...this.present(conv), messages: await this.messages(conv.id, Number(userMsg) - 1) };
    }

    const history = await this.history(conv.id);
    const name = (await this.db.query(`select display_name from users where id = $1`, [p.userId])).rows[0].display_name;
    let reply;
    try {
      reply = await this.assistant.reply({ history, user: { name, surface: conv.surface }, tools: this.toolkit(p) });
    } catch (e) {
      this.log.error(`assistant failed: ${(e as Error).message}`);
      await this.db.query(`insert into ai_requests (use_case, ms, failed) values ('help_chat', 0, true)`);
      reply = { text: 'The assistant is not available right now. I have passed your message to a person on the help team.', handoff: 'Assistant unavailable', sources: [], model: 'none', ms: 0, inputTokens: 0, outputTokens: 0 };
    }
    await this.db.query(`insert into help_messages (conversation_id, role, body, sources) values ($1, 'bot', $2, $3)`, [conv.id, reply.text.slice(0, 8000), JSON.stringify(reply.sources)]);
    if (reply.model !== 'none') {
      // Opus 5.5 list prices: $4 in, $20 out per million tokens, at about ₦1,600 to the dollar.
      const kobo = Math.round(((reply.inputTokens * 4 + reply.outputTokens * 20) / 1_000_000) * 1600 * 100);
      await this.db.query(`insert into ai_requests (use_case, ms, to_review, cost_kobo) values ('help_chat', $1, $2, $3)`, [reply.ms, !!reply.handoff, kobo]);
    }
    if (reply.handoff) await this.handoff(p, conv.id, reply.handoff);
    const after = (await this.db.query(`select * from help_conversations where id = $1`, [conv.id])).rows[0];
    return { ...this.present(after), messages: await this.messages(conv.id, Number(userMsg) - 1) };
  }

  private async history(id: string): Promise<HelpTurn[]> {
    const rows = (await this.db.query(`select role, body from help_messages where conversation_id = $1 and role in ('user', 'bot', 'agent') order by id desc limit 30`, [id])).rows.reverse();
    // The model sees the team's replies as its own earlier turns, so it can carry on after a hand-back.
    const turns: HelpTurn[] = [];
    for (const r of rows) {
      const role = r.role === 'user' ? 'user' : 'assistant';
      const text = r.role === 'agent' ? `(A person on the help team wrote:) ${r.body}` : r.body;
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.text += `\n\n${text}`;
      else turns.push({ role, text });
    }
    while (turns.length && turns[0]!.role !== 'user') turns.shift();
    return turns;
  }

  /** "Talk to a person", or the assistant's own hand-off: opens a ticket and tells the help team. */
  async askHuman(p: Principal, id: string, reason?: string) {
    const c = await this.conversation(p, id);
    if (c.state === 'closed') throw new AppError(409, 'closed', 'This chat is closed. Start a new one.');
    if (c.state !== 'bot') return { ...this.present(c), message: 'A person already has this chat.' };
    await this.handoff(p, id, reason?.trim() || 'The person asked for a person');
    await this.db.query(`insert into help_messages (conversation_id, role, body) values ($1, 'bot', $2)`, [id, 'I have asked a person on the help team to join. They will reply here, usually within one working day.']);
    const after = await this.conversation(p, id);
    return { ...this.present(after), messages: await this.messages(id) };
  }

  private async handoff(p: Principal, id: string, reason: string) {
    await this.db.tx(async (c) => {
      const conv = (await c.query(`select * from help_conversations where id = $1 for update`, [id])).rows[0];
      if (conv.state !== 'bot') return;
      const lastUser = (await c.query(`select string_agg(body, ' / ' order by id) as t from (select id, body from help_messages where conversation_id = $1 and role = 'user' order by id desc limit 3) x`, [id])).rows[0].t ?? '';
      let number = '';
      for (;;) {
        number = `S-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from support_tickets where number = $1`, [number])).rowCount) break;
      }
      const body = `Help chat: ${reason}. ${lastUser}`.slice(0, 2000).padEnd(10, '.');
      const t = (await c.query(`insert into support_tickets (number, user_id, topic, body, related_id) values ($1, $2, 'other', $3, $4) returning id`, [number, p.userId, body, id])).rows[0].id;
      await c.query(`update help_conversations set state = 'waiting_human', handoff_reason = $2, ticket_id = $3 where id = $1`, [id, reason.slice(0, 300), t]);
      await notify(c, await this.helpTeam(c), { type: 'help_chat_handoff', grp: 'team', title: 'A help chat needs a person', body: reason.slice(0, 140), link: `/admin/support?chat=${id}` });
    });
  }

  private async helpTeam(c: Queryable): Promise<string[]> {
    return (await c.query(`select distinct user_id from user_roles where role in ('platform_admin', 'platform_support')`)).rows.map((x) => x.user_id);
  }

  async close(p: Principal, id: string, rating?: number) {
    await this.conversation(p, id);
    await this.db.query(`update help_conversations set state = 'closed', rating = coalesce($2, rating) where id = $1`, [id, rating ?? null]);
    return { message: 'Chat closed. Thank you.' };
  }

  // ---------------------------------------------------------------- the assistant's lookups (own data only)

  private toolkit(p: Principal): HelpToolKit {
    return {
      searchAgencies: async (query) => {
        const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
        const rows = (await this.db.query(`select id, name, kind, status from agencies where status in ('live', 'overdue', 'setting_up') order by name`)).rows;
        const out = rows.map((a) => {
          const h = agencyHandles(a.kind);
          const tips = tipCategories.filter((t) => t.agencyKinds.includes(a.kind)).map((t) => t.label);
          const issues = issueCategories.filter((t) => t.agencyKinds.includes(a.kind)).map((t) => t.label);
          const handles = ['emergencies', ...(h.tips ? [`tips (${tips.join(', ') || 'general'})`] : []), ...(h.issues ? [`public issues (${issues.join(', ') || 'general'})`] : [])].join(', ');
          return { name: a.name, kind: KIND[a.kind] ?? cap(a.kind), status: a.status === 'live' ? 'Receiving reports' : 'Joining', handles, hay: `${a.name} ${a.kind} ${KIND[a.kind] ?? ''} ${handles}`.toLowerCase() };
        });
        const hits = words.length ? out.filter((a) => words.some((w) => a.hay.includes(w))) : out;
        return (hits.length ? hits : out).slice(0, 8).map(({ hay: _hay, ...a }) => a);
      },
      searchLearn: async (query) => {
        const words = query.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).slice(0, 6);
        if (!words.length) return [];
        const r = await this.db.query(
          `select id, title, caption, format, topic from learn_posts where state = 'live' and (${words.map((_, i) => `(title ilike $${i + 1} or caption ilike $${i + 1} or coalesce(body, '') ilike $${i + 1} or topic ilike $${i + 1})`).join(' or ')}) order by created_at desc limit 5`,
          words.map((w) => `%${w}%`),
        );
        return r.rows.map((x) => ({ title: x.title, summary: x.caption, format: x.format, topic: x.topic, href: `/learn/${x.id}` }));
      },
      myReports: async () => {
        const inc = (
          await this.db.query(
            `select i.id, i.type, i.state, i.created_at, l.postcode from incidents i left join locations l on l.id = i.location_id where i.reporter_id = $1 order by i.created_at desc limit 5`,
            [p.userId],
          )
        ).rows.map((i) => ({ kind: 'emergency', label: `${cap(i.type)}, ${i.postcode ?? 'GPS'}`, status: citizenStatus(i.state as IncidentState).title, at: i.created_at }));
        const tips = (await this.db.query(`select category, state, created_at from tips where user_id = $1 order by created_at desc limit 3`, [p.userId])).rows.map((t) => ({ kind: 'tip', label: tipCategories.find((c) => c.code === t.category)?.label ?? t.category, status: t.state.replace(/_/g, ' '), at: t.created_at }));
        const issues = (
          await this.db.query(`select k.category, k.state, r.created_at from issue_reports r join issue_cases k on k.id = r.case_id where r.user_id = $1 order by r.created_at desc limit 3`, [p.userId])
        ).rows.map((t) => ({ kind: 'public issue', label: issueCategories.find((c) => c.code === t.category)?.label ?? t.category, status: t.state.replace(/_/g, ' '), at: t.created_at }));
        return [...inc, ...tips, ...issues];
      },
      myOpenItems: async () => ({
        statements: (await this.db.query(`select number, state, role from statements where citizen_id = $1 and state <> 'signed'`, [p.userId])).rows,
        fines: (await this.db.query(`select state, amount_kobo, created_at from fines where user_id = $1 and state in ('open', 'appealed')`, [p.userId])).rows,
        tickets: (await this.db.query(`select number, topic, state from support_tickets where user_id = $1 and state <> 'closed'`, [p.userId])).rows,
      }),
    };
  }

  // ---------------------------------------------------------------- help team (human in the loop)

  async inbox(p: Principal, status: string) {
    requirePerm(p, 'platform.support');
    const where = status === 'all' ? 'true' : status === 'open' ? `c.state in ('waiting_human', 'human')` : 'c.state = $1';
    const r = await this.db.query(
      `select c.*, u.display_name as person, a.display_name as assignee,
              (select body from help_messages m where m.conversation_id = c.id order by id desc limit 1) as last,
              (select count(*)::int from help_messages m where m.conversation_id = c.id) as n
         from help_conversations c join users u on u.id = c.user_id left join users a on a.id = c.assigned_to
        where ${where} order by c.state = 'waiting_human' desc, c.updated_at desc limit 100`,
      where.includes('$1') ? [status] : [],
    );
    const counts = (await this.db.query(`select state, count(*)::int as n from help_conversations group by state`)).rows;
    return {
      counts: Object.fromEntries(counts.map((x) => [x.state, x.n])),
      items: r.rows.map((c) => ({ ...this.present(c), person: c.person, surface: c.surface, assignee: c.assignee, last: c.last, messages: c.n, at: c.updated_at })),
    };
  }

  async chat(p: Principal, id: string) {
    requirePerm(p, 'platform.support');
    const c = (await this.db.query(`select c.*, u.display_name as person, u.phone, t.number as ticket from help_conversations c join users u on u.id = c.user_id left join support_tickets t on t.id = c.ticket_id where c.id = $1`, [id])).rows[0];
    if (!c) throw new AppError(404, 'not_found', 'Chat not found.');
    return { ...this.present(c), person: c.person, phone: c.phone ? `•••• ${String(c.phone).slice(-4)}` : null, surface: c.surface, ticket: c.ticket, rating: c.rating, messages: await this.messages(id, 0, true) };
  }

  /** A person replies (taking the chat if nobody has it), or writes a note only the team sees. */
  async staffMessage(p: Principal, id: string, body: string, kind: 'reply' | 'note') {
    requirePerm(p, 'platform.support');
    const text = body.trim();
    if (text.length < 2) throw new AppError(422, 'validation_failed', 'Write a reply.', { fields: [{ field: 'body', message: 'Write a reply.' }] });
    return this.db.tx(async (c) => {
      const conv = (await c.query(`select * from help_conversations where id = $1 for update`, [id])).rows[0];
      if (!conv) throw new AppError(404, 'not_found', 'Chat not found.');
      if (conv.state === 'closed' && kind === 'reply') throw new AppError(409, 'closed', 'This chat is closed.');
      await c.query(`insert into help_messages (conversation_id, role, author_id, body) values ($1, $2, $3, $4)`, [id, kind === 'reply' ? 'agent' : 'note', p.userId, text.slice(0, 4000)]);
      if (kind === 'reply') {
        await c.query(`update help_conversations set state = 'human', assigned_to = coalesce(assigned_to, $2) where id = $1`, [id, p.userId]);
        if (conv.ticket_id) await c.query(`update support_tickets set state = 'answered', reply = $2, replied_by = $3, replied_at = now() where id = $1`, [conv.ticket_id, text.slice(0, 2000), p.userId]);
        await notify(c, [conv.user_id], { type: 'help_chat_reply', grp: 'account', title: 'The help team replied', body: text.slice(0, 140), link: conv.surface === 'officer' ? '/officer/chat' : conv.surface === 'staff' ? '/?chat=open' : '/chat' });
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_support', action: kind === 'reply' ? 'support.chat_reply' : 'support.chat_note', entity: 'help_conversation', entityId: id }, c);
      return { message: kind === 'reply' ? 'Sent. They see it in the chat.' : 'Note added. Only the team sees it.' };
    });
  }

  /** Hand the chat back to the assistant, or close it. */
  async staffState(p: Principal, id: string, to: 'bot' | 'closed') {
    requirePerm(p, 'platform.support');
    const r = await this.db.query(`update help_conversations set state = $2, assigned_to = case when $2 = 'bot' then null else assigned_to end where id = $1 returning user_id, ticket_id`, [id, to]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Chat not found.');
    if (to === 'closed' && r.rows[0].ticket_id) await this.db.query(`update support_tickets set state = 'closed' where id = $1`, [r.rows[0].ticket_id]);
    await this.db.query(`insert into help_messages (conversation_id, role, body) values ($1, 'bot', $2)`, [
      id,
      to === 'bot' ? 'The help team has handed you back to the assistant. Ask for a person again any time.' : 'The help team closed this chat. Start a new one any time.',
    ]);
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_support', action: `support.chat_${to === 'bot' ? 'release' : 'close'}`, entity: 'help_conversation', entityId: id });
    return { message: to === 'bot' ? 'Handed back to the assistant.' : 'Chat closed.' };
  }
}
