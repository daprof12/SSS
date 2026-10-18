// Learn: the citizen feed (For you, General, search, filter) and the platform team's
// review workflow (draft → in review → live; a second person approves).
import {
  applyEvent,
  checkLearnPost,
  LEARN_MIN_INTERESTS,
  learnLanguages,
  learnPostMachine,
  learnTopic,
  learnTopics,
  rankForYou,
  type LearnFormat,
  type QuizQuestion,
} from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';

const PAGE = 8;
const LANGS = learnLanguages.map((l) => l.code) as string[];

export interface BrowseQuery {
  q?: string;
  format?: LearnFormat | 'all';
  topics?: string[];
  languages?: string[];
  length?: 'short' | 'medium' | 'long';
  from?: string; // agency id, or 'platform'
  sort?: 'best' | 'newest' | 'most_viewed';
  saved?: boolean;
}

export interface PostInput {
  title: string;
  caption: string;
  topic: string;
  format: LearnFormat;
  language: string;
  body?: string | null;
  quiz?: QuizQuestion[] | null;
  durationS?: number | null;
  sourceAgencyId?: string | null;
  audienceState?: string | null;
}

@Injectable()
export class LearnService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  // ---------------------------------------------------------------- shared

  /** Fields every card and row needs, with this person's reaction. */
  private async present(c: Queryable, rows: any[], userId: string) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const media = (await c.query(`select distinct on (owner_id) owner_id, id, kind from media where owner_type = 'learn_post' and owner_id = any($1::uuid[]) and state = 'ready' order by owner_id, created_at desc`, [ids])).rows;
    const mine = (await c.query(`select * from learn_reactions where user_id = $1 and post_id = any($2::uuid[])`, [userId, ids])).rows;
    const m = new Map(media.map((x) => [x.owner_id, x]));
    const r = new Map(mine.map((x) => [x.post_id, x]));
    return rows.map((p) => {
      const t = learnTopic(p.topic);
      const md = m.get(p.id);
      const me = r.get(p.id);
      return {
        id: p.id as string,
        title: p.title as string,
        caption: p.caption as string,
        format: p.format as LearnFormat,
        topic: { code: p.topic as string, label: t?.label ?? p.topic, icon: t?.icon ?? 'learn', tone: t?.tone ?? 'signal' },
        language: p.language as string,
        durationS: p.duration_s as number | null,
        source: (p.source_name as string | null) ?? 'Platform team',
        sourceAgencyId: p.source_agency as string | null,
        media: md ? { id: md.id as string, kind: md.kind as string, url: `/media/${md.id}/content` } : null,
        likes: p.like_count as number,
        views: p.view_count as number,
        publishedAt: p.published_at as Date | null,
        // Video steps and the article excerpt are shown on the card itself.
        body: p.format === 'quiz' ? null : ((p.body as string | null) ?? null),
        me: { liked: !!me?.liked, saved: !!me?.saved, seen: !!me?.seen_at, completed: !!me?.completed, quizScore: me?.quiz_score ?? null },
      };
    });
  }

  private async myState(userId: string): Promise<string | null> {
    const r = await this.db.query(`select l.state_id from saved_places sp join locations l on l.id = sp.location_id where sp.user_id = $1 and sp.is_home`, [userId]);
    return r.rows[0]?.state_id ?? null;
  }

  private readonly SELECT = `select p.*, a.name as source_name from learn_posts p left join agencies a on a.id = p.source_agency`;

  // ---------------------------------------------------------------- citizens

  async topics() {
    const counts = new Map((await this.db.query(`select topic, count(*)::int as n from learn_posts where state = 'live' group by topic`)).rows.map((r) => [r.topic, r.n]));
    const sources = (await this.db.query(`select distinct a.id, a.name from learn_posts p join agencies a on a.id = p.source_agency where p.state = 'live' order by a.name`)).rows;
    return {
      topics: learnTopics.map((t) => ({ ...t, items: counts.get(t.code) ?? 0 })),
      languages: learnLanguages,
      sources: [{ id: 'platform', name: 'Platform team' }, ...sources],
    };
  }

  async interests(p: Principal) {
    const r = (await this.db.query(`select topics, languages from learn_interests where user_id = $1`, [p.userId])).rows[0];
    return { chosen: !!r, topics: r?.topics ?? [], languages: r?.languages ?? ['en'], min: LEARN_MIN_INTERESTS };
  }

  async setInterests(p: Principal, b: { topics: string[]; languages: string[] }) {
    const topics = [...new Set(b.topics)].filter((t) => learnTopic(t));
    const languages = [...new Set(b.languages)].filter((l) => LANGS.includes(l));
    if (topics.length < LEARN_MIN_INTERESTS) throw new AppError(422, 'validation_failed', `Pick at least ${LEARN_MIN_INTERESTS}.`, { fields: [{ field: 'topics', message: `Pick at least ${LEARN_MIN_INTERESTS}.` }] });
    if (!languages.length) throw new AppError(422, 'validation_failed', 'Choose at least one language.', { fields: [{ field: 'languages', message: 'Choose at least one language.' }] });
    await this.db.query(
      `insert into learn_interests (user_id, topics, languages) values ($1, $2, $3)
       on conflict (user_id) do update set topics = excluded.topics, languages = excluded.languages, updated_at = now()`,
      [p.userId, topics, languages],
    );
    // Picking a topic again undoes an earlier "Not interested" on it.
    await this.db.query(`update learn_reactions r set not_interested = false from learn_posts p where p.id = r.post_id and r.user_id = $1 and p.topic = any($2::text[]) and r.not_interested`, [p.userId, topics]);
    return { topics, languages };
  }

  /** "For you": ranked by interests and watching; seen posts sink; muted topics vanish. */
  async forYou(p: Principal, offset = 0) {
    const state = await this.myState(p.userId);
    const posts = (await this.db.query(`${this.SELECT} where p.state = 'live' and (p.audience_state is null or p.audience_state = $1) order by p.published_at desc limit 500`, [state])).rows;
    const reactions = (await this.db.query(`select r.*, p.topic from learn_reactions r join learn_posts p on p.id = r.post_id where r.user_id = $1`, [p.userId])).rows;
    const me = await this.interests(p);
    const watchedTopics: Record<string, number> = {};
    const muted = new Set<string>();
    const seen = new Set<string>();
    for (const r of reactions) {
      if (r.completed || r.watched_s >= 10) watchedTopics[r.topic] = (watchedTopics[r.topic] ?? 0) + 1;
      if (r.not_interested) muted.add(r.topic);
      if (r.seen_at) seen.add(r.post_id);
    }
    const now = Date.now();
    const ranked = posts
      .map((x) => ({ x, ...rankForYou({ topic: x.topic, language: x.language, publishedAt: new Date(x.published_at).getTime(), seen: seen.has(x.id), liked: false }, { interests: me.topics, languages: me.languages, watchedTopics, mutedTopics: [...muted], now }) }))
      .filter((r) => r.score > -Infinity && !seen.has(r.x.id))
      .sort((a, b) => b.score - a.score);
    const slice = ranked.slice(offset, offset + PAGE);
    const items = await this.present(this.db.pool, slice.map((r) => r.x), p.userId);
    return {
      items: items.map((it, i) => ({ ...it, reason: slice[i]!.reason })),
      next: offset + PAGE < ranked.length ? offset + PAGE : null,
      // "You are all caught up": nothing unseen left.
      caughtUp: offset + PAGE >= ranked.length,
      needsInterests: !me.chosen,
    };
  }

  /** General tab, topic pages, filter sheet ("Show [n] results") and search. */
  async browse(p: Principal, q: BrowseQuery) {
    const state = await this.myState(p.userId);
    const where = [`p.state = 'live'`, `(p.audience_state is null or p.audience_state = $1)`];
    const args: unknown[] = [state];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (q.format && q.format !== 'all') add(`p.format = ?`, q.format);
    if (q.topics?.length) add(`p.topic = any(?::text[])`, q.topics);
    if (q.languages?.length) add(`p.language = any(?::text[])`, q.languages);
    if (q.length === 'short') where.push(`coalesce(p.duration_s, 0) < 60`);
    if (q.length === 'medium') where.push(`p.duration_s between 60 and 180`);
    if (q.length === 'long') where.push(`p.duration_s > 180`);
    if (q.from === 'platform') where.push(`p.source_agency is null`);
    else if (q.from) add(`p.source_agency = ?::uuid`, q.from);
    if (q.saved) add(`exists (select 1 from learn_reactions r where r.post_id = p.id and r.user_id = ? and r.saved)`, p.userId);
    if (q.q?.trim()) {
      const topicsHit = learnTopics.filter((t) => t.label.toLowerCase().includes(q.q!.trim().toLowerCase())).map((t) => t.code);
      args.push(`%${q.q.trim().replace(/[%_]/g, '')}%`);
      const n = args.length;
      args.push(topicsHit);
      where.push(`(p.title ilike $${n} or p.caption ilike $${n} or p.body ilike $${n} or a.name ilike $${n} or p.topic = any($${n + 1}::text[]))`);
    }
    const order = q.sort === 'newest' ? 'p.published_at desc' : q.sort === 'most_viewed' ? 'p.view_count desc, p.published_at desc' : 'p.like_count + p.view_count / 10 desc, p.published_at desc';
    const sql = `${this.SELECT} where ${where.join(' and ')} order by ${order}`;
    const total = (await this.db.query(`select count(*)::int as n from (${sql}) x`, args)).rows[0].n;
    const rows = (await this.db.query(`${sql} limit 50`, args)).rows;
    const agencies = q.q?.trim()
      ? (await this.db.query(`select distinct a.id, a.name from agencies a join learn_posts p on p.source_agency = a.id where p.state = 'live' and a.name ilike $1`, [`%${q.q.trim()}%`])).rows
      : [];
    return { total, items: await this.present(this.db.pool, rows, p.userId), agencies };
  }

  /** Search suggestions as the person types: phrases from live titles. */
  async suggest(q: string) {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const rows = (await this.db.query(`select title from learn_posts where state = 'live' and (title ilike $1 or caption ilike $1) order by view_count desc limit 8`, [`%${term.replace(/[%_]/g, '')}%`])).rows;
    const out = new Set<string>();
    for (const t of learnTopics) if (t.label.toLowerCase().includes(term)) out.add(t.label.toLowerCase());
    for (const r of rows) out.add(String(r.title).toLowerCase().replace(/[?.!]+$/, ''));
    return [...out].slice(0, 5);
  }

  async post(p: Principal, id: string) {
    const admin = hasRole(p, 'platform_admin');
    const row = (await this.db.query(`${this.SELECT} where p.id = $1`, [id])).rows[0];
    if (!row || (row.state !== 'live' && !admin)) throw new AppError(404, 'not_found', 'This lesson is no longer available.');
    const [out] = await this.present(this.db.pool, [row], p.userId);
    const quiz = (row.quiz as QuizQuestion[] | null)?.map(({ q, options }) => ({ q, options })) ?? null; // answers stay on the server
    return { ...out, quiz, state: row.state };
  }

  /** Like, save, Not interested, seen and progress. Counts move once per person. */
  async react(p: Principal, id: string, b: { liked?: boolean; saved?: boolean; notInterested?: boolean; seen?: boolean; watchedS?: number; completed?: boolean }) {
    return this.db.tx(async (c) => {
      const post = (await c.query(`select id, state from learn_posts where id = $1 for update`, [id])).rows[0];
      if (!post || post.state !== 'live') throw new AppError(404, 'not_found', 'This lesson is no longer available.');
      const before = (await c.query(`select * from learn_reactions where post_id = $1 and user_id = $2`, [id, p.userId])).rows[0];
      const r = (
        await c.query(
          `insert into learn_reactions (post_id, user_id, liked, saved, not_interested, seen_at, watched_s, completed)
           values ($1, $2, coalesce($3, false), coalesce($4, false), coalesce($5, false), case when $6 then now() end, coalesce($7, 0), coalesce($8, false))
           on conflict (post_id, user_id) do update set
             liked = coalesce($3, learn_reactions.liked),
             saved = coalesce($4, learn_reactions.saved),
             not_interested = coalesce($5, learn_reactions.not_interested),
             seen_at = coalesce(learn_reactions.seen_at, case when $6 then now() end),
             watched_s = greatest(learn_reactions.watched_s, coalesce($7, 0)),
             completed = learn_reactions.completed or coalesce($8, false),
             updated_at = now()
           returning *`,
          [id, p.userId, b.liked ?? null, b.saved ?? null, b.notInterested ?? null, b.seen ?? false, b.watchedS ?? null, b.completed ?? null],
        )
      ).rows[0];
      const likeDelta = (r.liked ? 1 : 0) - (before?.liked ? 1 : 0);
      const viewDelta = r.seen_at && !before?.seen_at ? 1 : 0;
      if (likeDelta || viewDelta) await c.query(`update learn_posts set like_count = greatest(0, like_count + $2), view_count = view_count + $3 where id = $1`, [id, likeDelta, viewDelta]);
      const counts = (await c.query(`select like_count from learn_posts where id = $1`, [id])).rows[0];
      return { liked: r.liked, saved: r.saved, notInterested: r.not_interested, completed: r.completed, likes: counts.like_count };
    });
  }

  async answerQuiz(p: Principal, id: string, answers: number[]) {
    const post = (await this.db.query(`select quiz, state from learn_posts where id = $1 and format = 'quiz'`, [id])).rows[0];
    if (!post || post.state !== 'live') throw new AppError(404, 'not_found', 'This quiz is no longer available.');
    const quiz = post.quiz as QuizQuestion[];
    if (answers.length !== quiz.length) throw new AppError(422, 'validation_failed', 'Answer every question.');
    const results = quiz.map((q, i) => ({ correct: answers[i] === q.answer, answer: q.answer, why: q.why }));
    const score = results.filter((r) => r.correct).length;
    await this.db.query(
      `insert into learn_reactions (post_id, user_id, completed, quiz_score, seen_at) values ($1, $2, true, $3, now())
       on conflict (post_id, user_id) do update set completed = true, quiz_score = greatest(coalesce(learn_reactions.quiz_score, 0), $3), seen_at = coalesce(learn_reactions.seen_at, now()), updated_at = now()`,
      [id, p.userId, score],
    );
    return { score, total: quiz.length, results };
  }

  // ---------------------------------------------------------------- platform team

  private requireAdmin(p: Principal) {
    if (!hasRole(p, 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }

  async adminList(p: Principal, state: 'draft' | 'in_review' | 'live' | 'removed') {
    this.requireAdmin(p);
    const counts = Object.fromEntries((await this.db.query(`select state, count(*)::int as n from learn_posts group by state`)).rows.map((r) => [r.state, r.n]));
    const rows = (
      await this.db.query(
        `select p.*, a.name as source_name, u.display_name as author, s.display_name as submitter
           from learn_posts p left join agencies a on a.id = p.source_agency join users u on u.id = p.created_by left join users s on s.id = p.submitted_by
          where p.state = $1 order by p.updated_at desc limit 200`,
        [state],
      )
    ).rows;
    const shown = await this.present(this.db.pool, rows, p.userId);
    return {
      counts: { live: counts.live ?? 0, in_review: counts.in_review ?? 0, draft: counts.draft ?? 0, removed: counts.removed ?? 0 },
      items: rows.map((r, i) => ({
        ...shown[i]!,
        state: r.state,
        body: r.body,
        quiz: r.quiz,
        audienceState: r.audience_state,
        author: r.author,
        submittedBy: r.submitter,
        submittedByMe: r.submitted_by === p.userId,
        reviewNote: r.review_note,
        removedReason: r.removed_reason,
        updatedAt: r.updated_at,
      })),
    };
  }

  async sources(p: Principal) {
    this.requireAdmin(p);
    const agencies = (await this.db.query(`select id, name from agencies where status in ('live', 'overdue', 'setting_up') order by name`)).rows;
    return { agencies, states: [{ code: 'LA', name: 'Lagos' }, { code: 'FC', name: 'FCT Abuja' }] };
  }

  private clean(b: PostInput) {
    if (!learnTopic(b.topic)) throw new AppError(422, 'validation_failed', 'Choose a topic.', { fields: [{ field: 'topic', message: 'Choose a topic.' }] });
    if (!LANGS.includes(b.language)) throw new AppError(422, 'validation_failed', 'Choose a language.', { fields: [{ field: 'language', message: 'Choose a language.' }] });
    // Reading time for articles: about 200 words a minute.
    const durationS = b.format === 'article' ? Math.max(30, Math.round(((b.body ?? '').trim().split(/\s+/).length / 200) * 60)) : b.format === 'quiz' ? (b.quiz?.length ?? 1) * 20 : (b.durationS ?? null);
    return { ...b, durationS };
  }

  async create(p: Principal, b: PostInput) {
    this.requireAdmin(p);
    const x = this.clean(b);
    const r = (
      await this.db.query(
        `insert into learn_posts (title, caption, body, quiz, format, topic, language, duration_s, source_agency, audience_state, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [x.title.trim(), x.caption.trim(), x.body ?? null, x.quiz ? JSON.stringify(x.quiz) : null, x.format, x.topic, x.language, x.durationS, x.sourceAgencyId ?? null, x.audienceState ?? null, p.userId],
      )
    ).rows[0];
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'learn.create', entity: 'learn_post', entityId: r.id, payload: { title: x.title } });
    return { id: r.id, state: 'draft' };
  }

  async update(p: Principal, id: string, b: PostInput) {
    this.requireAdmin(p);
    const x = this.clean(b);
    const r = await this.db.query(
      `update learn_posts set title = $2, caption = $3, body = $4, quiz = $5, format = $6, topic = $7, language = $8, duration_s = $9, source_agency = $10, audience_state = $11, updated_at = now()
        where id = $1 and state = 'draft' returning id`,
      [id, x.title.trim(), x.caption.trim(), x.body ?? null, x.quiz ? JSON.stringify(x.quiz) : null, x.format, x.topic, x.language, x.durationS, x.sourceAgencyId ?? null, x.audienceState ?? null],
    );
    if (!r.rowCount) throw new AppError(409, 'not_editable', 'Only drafts can be edited. Send it back to draft first.');
    return { id, state: 'draft' };
  }

  async act(p: Principal, id: string, event: 'submit' | 'approve' | 'send_back' | 'remove' | 'restore', note?: string) {
    this.requireAdmin(p);
    return this.db.tx(async (c) => {
      const post = (await c.query(`select * from learn_posts where id = $1 for update`, [id])).rows[0];
      if (!post) throw new AppError(404, 'not_found', 'Post not found.');
      const r = applyEvent(learnPostMachine, post.state, event, 'platform_admin');
      if (!r.ok) throw new AppError(409, r.code, 'That is not possible at this stage.');
      const set: string[] = [`state = '${r.to}'`, 'updated_at = now()'];
      const args: unknown[] = [id];
      if (event === 'submit') {
        const media = (await c.query(`select 1 from media where owner_type = 'learn_post' and owner_id = $1 and state = 'ready' and kind = 'video'`, [id])).rowCount;
        const problem = checkLearnPost({ title: post.title, caption: post.caption, topic: post.topic, format: post.format, body: post.body, quiz: post.quiz, hasMedia: !!media });
        if (problem) throw new AppError(422, 'incomplete', problem.message, { fields: [problem] });
        args.push(p.userId);
        set.push(`submitted_by = $${args.length}`, 'review_note = null');
      }
      if (event === 'approve') {
        if (post.submitted_by === p.userId) throw new AppError(409, 'same_reviewer', 'Someone else must review a post you sent.');
        args.push(p.userId);
        set.push(`reviewed_by = $${args.length}`, 'published_at = now()');
      }
      if (event === 'send_back' || event === 'remove') {
        if (!note?.trim()) throw new AppError(422, 'note_required', event === 'remove' ? 'Say why it is being removed.' : 'Say what needs to change.');
        args.push(note.trim());
        set.push(event === 'remove' ? `removed_reason = $${args.length}` : `review_note = $${args.length}`);
      }
      if (event === 'restore') set.push('removed_reason = null', 'published_at = null', 'reviewed_by = null');
      await c.query(`update learn_posts set ${set.join(', ')} where id = $1`, args);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: `learn.${event}`, entity: 'learn_post', entityId: id, reason: note }, c);
      const message = { submit: 'Sent for review.', approve: 'Approved. It is live now.', send_back: 'Sent back to draft with your note.', remove: 'Removed from the feed.', restore: 'Restored as a draft.' }[event];
      return { state: r.to, message };
    });
  }
}
