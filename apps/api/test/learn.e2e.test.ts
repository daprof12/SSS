// Learn: interests, For you, General/search/filter, reactions, quizzes, and the review workflow.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config';
import { Db } from '../src/core/db';
import { createApp } from '../src/main';

let app: INestApplication;
let http: ReturnType<typeof request>;
let db: Db;
let seed: { users: Record<string, string> };
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  seed = (await http.post('/dev/seed').expect(201)).body;
  for (const [k, id] of Object.entries(seed.users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  const admin2 = (await db.query(`insert into users (phone, display_name) values ('+2348039990011', 'Content Reviewer') returning id`)).rows[0].id;
  await db.query(`insert into user_roles (user_id, role, scope_type) values ($1, 'platform_admin', 'platform')`, [admin2]);
  t.admin2 = (await http.post('/dev/token').send({ userId: admin2 }).expect(201)).body.token;
});
afterAll(async () => {
  await app?.close();
});

describe('interests and For you', () => {
  it('asks for interests first, then ranks by them', async () => {
    const before = (await http.get('/learn/feed').set(as('citizen')).expect(200)).body;
    expect(before.needsInterests).toBe(true);

    expect((await http.put('/me/learn/interests').set(as('citizen')).send({ topics: ['first_aid', 'fire_safety'], languages: ['en'] }).expect(422)).body.message).toBe('Pick at least 3.');
    await http.put('/me/learn/interests').set(as('citizen')).send({ topics: ['first_aid', 'scams_fraud', 'child_safety'], languages: ['en'] }).expect(200);

    const feed = (await http.get('/learn/feed').set(as('citizen')).expect(200)).body;
    expect(feed.needsInterests).toBe(false);
    expect(feed.items.length).toBeGreaterThan(3);
    expect(feed.items[0].reason).toMatch(/^Because you picked /);
    expect(['first_aid', 'scams_fraud', 'child_safety']).toContain(feed.items[0].topic.code);
  });

  it('learns from watching, drops seen posts, and hides a topic marked Not interested', async () => {
    const all = (await http.get('/learn/browse?topics=fire_safety').set(as('citizen'))).body.items;
    const fireVideo = all.find((x: any) => x.format === 'video');
    await http.post(`/learn/posts/${fireVideo.id}/react`).set(as('citizen')).send({ seen: true, watchedS: 30, completed: true }).expect(201);

    let feed = (await http.get('/learn/feed').set(as('citizen'))).body;
    expect(feed.items.find((x: any) => x.id === fireVideo.id)).toBeUndefined();
    expect(feed.items.find((x: any) => x.topic.code === 'fire_safety').reason).toBe('Shown because you watch Fire safety');

    const scam = feed.items.find((x: any) => x.topic.code === 'scams_fraud');
    await http.post(`/learn/posts/${scam.id}/react`).set(as('citizen')).send({ notInterested: true }).expect(201);
    feed = (await http.get('/learn/feed').set(as('citizen'))).body;
    expect(feed.items.some((x: any) => x.topic.code === 'scams_fraud')).toBe(false);

    // Seeing everything ends in "You are all caught up".
    const everything = (await http.get('/learn/browse').set(as('citizen'))).body.items;
    for (const p of everything) await http.post(`/learn/posts/${p.id}/react`).set(as('citizen')).send({ seen: true }).expect(201);
    feed = (await http.get('/learn/feed').set(as('citizen'))).body;
    expect(feed).toMatchObject({ items: [], caughtUp: true });
  });
});

describe('General, search and filter', () => {
  it('lists topics with counts, filters, searches and keeps saved posts', async () => {
    const topics = (await http.get('/learn/topics').set(as('neighbour')).expect(200)).body;
    expect(topics.topics.find((x: any) => x.code === 'fire_safety').items).toBe(3);
    expect(topics.sources.map((s: any) => s.name)).toContain('Platform team');

    const quizzes = (await http.get('/learn/browse?format=quiz').set(as('neighbour'))).body;
    expect(quizzes.items.every((x: any) => x.format === 'quiz')).toBe(true);
    expect((await http.get('/learn/browse?languages=pcm').set(as('neighbour'))).body.items.map((x: any) => x.language)).toEqual(['pcm']);
    expect((await http.get('/learn/browse?length=short&format=video').set(as('neighbour'))).body.items.every((x: any) => x.durationS < 60)).toBe(true);

    const fire = (await http.get('/learn/browse?q=fire').set(as('neighbour'))).body;
    expect(fire.total).toBeGreaterThanOrEqual(3);
    expect(fire.items[0].title).toMatch(/fire/i);
    expect((await http.get('/learn/suggest?q=fire').set(as('neighbour'))).body).toContain('fire safety');
    const police = (await http.get('/learn/browse?q=police').set(as('neighbour'))).body;
    expect(police.agencies.map((a: any) => a.name)).toEqual(['Nigeria Police Force (demo)']);

    const first = fire.items[0];
    const liked = (await http.post(`/learn/posts/${first.id}/react`).set(as('neighbour')).send({ liked: true, saved: true }).expect(201)).body;
    expect(liked.likes).toBe(first.likes + 1);
    expect((await http.post(`/learn/posts/${first.id}/react`).set(as('neighbour')).send({ liked: true }).expect(201)).body.likes).toBe(first.likes + 1); // once per person
    expect((await http.get('/learn/browse?saved=1').set(as('neighbour'))).body.items.map((x: any) => x.id)).toEqual([first.id]);
  });

  it('marks a quiz on the server without sending the answers to the phone', async () => {
    const q = (await http.get('/learn/browse?format=quiz&topics=fire_safety').set(as('neighbour'))).body.items[0];
    const detail = (await http.get(`/learn/posts/${q.id}`).set(as('neighbour')).expect(200)).body;
    expect(detail.quiz[0]).not.toHaveProperty('answer');
    await http.post(`/learn/posts/${q.id}/quiz`).set(as('neighbour')).send({ answers: [1] }).expect(422);
    const r = (await http.post(`/learn/posts/${q.id}/quiz`).set(as('neighbour')).send({ answers: [1, 0, 1] }).expect(201)).body;
    expect(r).toMatchObject({ score: 2, total: 3 });
    expect(r.results[1]).toMatchObject({ correct: false, answer: 1 });
  });
});

describe('admin learn feed', () => {
  it('drafts, sends for review, needs a second person to approve, and can remove with a reason', async () => {
    await http.get('/admin/learn/posts').set(as('citizen')).expect(403);
    const draft = (
      await http
        .post('/admin/learn/posts')
        .set(as('platformAdmin'))
        .send({ title: 'Keep the gate locked at night', caption: '', topic: 'home_security', format: 'article', language: 'en', body: 'Short.' })
        .expect(201)
    ).body;
    const act = (who: string, event: string, note?: string) => http.post(`/admin/learn/posts/${draft.id}/actions`).set(as(who)).send({ event, note });
    expect((await act('platformAdmin', 'submit').expect(422)).body.message).toBe('Add a short tip, one or two lines.');

    const body = 'A locked gate is the first thing that keeps people out. Lock it when the last person comes home, and check it before you sleep. Put a light at the gate so anyone there can be seen from the house and the street.';
    await http.patch(`/admin/learn/posts/${draft.id}`).set(as('platformAdmin')).send({ title: 'Keep the gate locked at night', caption: 'Lock it, light it, check it before bed.', topic: 'home_security', format: 'article', language: 'en', body }).expect(200);
    expect((await act('platformAdmin', 'submit').expect(201)).body.state).toBe('in_review');
    await http.patch(`/admin/learn/posts/${draft.id}`).set(as('platformAdmin')).send({ title: 'x', caption: 'y', topic: 'home_security', format: 'article', language: 'en', body }).expect(409);

    expect((await act('platformAdmin', 'approve').expect(409)).body.message).toBe('Someone else must review a post you sent.');
    await http.get(`/learn/posts/${draft.id}`).set(as('citizen')).expect(404);
    expect((await act('admin2', 'approve').expect(201)).body).toMatchObject({ state: 'live', message: 'Approved. It is live now.' });
    expect((await http.get(`/learn/posts/${draft.id}`).set(as('citizen')).expect(200)).body.durationS).toBeGreaterThanOrEqual(30);

    const list = (await http.get('/admin/learn/posts?state=live').set(as('platformAdmin')).expect(200)).body;
    expect(list.counts.live).toBe(13);
    expect(list.items[0]).toMatchObject({ title: 'Keep the gate locked at night', author: 'Platform Admin', submittedBy: 'Platform Admin' });

    expect((await act('admin2', 'remove').expect(422)).body.message).toBe('Say why it is being removed.');
    await act('admin2', 'remove', 'Duplicate of the night check quiz').expect(201);
    await http.get(`/learn/posts/${draft.id}`).set(as('citizen')).expect(404);
    expect((await db.query(`select count(*)::int as n from audit_log where entity = 'learn_post' and entity_id = $1`, [draft.id])).rows[0].n).toBe(4);
  });

  it('needs footage before a video goes for review', async () => {
    const v = (await http.post('/admin/learn/posts').set(as('platformAdmin')).send({ title: 'Crossing at a junction', caption: 'Look both ways twice.', topic: 'road_safety', format: 'video', language: 'en', durationS: 30 }).expect(201)).body;
    expect((await http.post(`/admin/learn/posts/${v.id}/actions`).set(as('platformAdmin')).send({ event: 'submit' }).expect(422)).body.message).toBe('Upload the video before sending it for review.');
    const reg = (await http.post('/media').set(as('platformAdmin')).send({ ownerType: 'learn_post', ownerId: v.id, contentType: 'video/mp4', sizeBytes: 40 }).expect(201)).body;
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(28, 1)]);
    await http.put(reg.uploadUrl).set(as('platformAdmin')).set('Content-Type', 'video/mp4').send(mp4).expect(200);
    await http.post('/media').set(as('citizen')).send({ ownerType: 'learn_post', ownerId: v.id, contentType: 'video/mp4', sizeBytes: 40 }).expect(404);
    expect((await http.post(`/admin/learn/posts/${v.id}/actions`).set(as('platformAdmin')).send({ event: 'submit' }).expect(201)).body.state).toBe('in_review');
  });
});
