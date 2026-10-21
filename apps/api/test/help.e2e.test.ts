// Help chat: the assistant answers from the guide and live lookups (offline stand-in in tests), hands
// to a person when asked, and the help team replies, notes, hands back or closes.
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config';
import { createApp } from '../src/main';

let app: INestApplication;
let http: ReturnType<typeof request>;
let users: Record<string, string>;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  users = (await http.post('/dev/seed').expect(201)).body.users;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
});
afterAll(async () => {
  await app?.close();
});

describe('help chat', () => {
  let chat = '';
  it('answers from the platform guide, and puts safety first when someone may be in danger', async () => {
    expect((await http.get('/me/help/chat').set(as('citizen')).expect(200)).body).toEqual({});
    const r = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'How much does the platform keep from a donation?' }).expect(201)).body;
    chat = r.id;
    expect(r.state).toBe('bot');
    expect(r.messages.map((m: any) => m.role)).toEqual(['user', 'bot']);
    expect(r.messages[1].body).toMatch(/30%/);
    const d = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'Robbers are at my gate, how do statements work after?', conversationId: chat }).expect(201)).body;
    expect(d.messages.at(-1).body).toMatch(/^If you or someone is in danger now, press SOS in the app or call 112\./);
  });

  it('looks up agencies on the platform and the person’s own reports', async () => {
    const a = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'Which agency handles human trafficking?', conversationId: chat }).expect(201)).body;
    expect(a.messages.at(-1).body).toMatch(/NAPTIP/);
    const m = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'What is the status of my report?', conversationId: chat }).expect(201)).body;
    expect(m.messages.at(-1).body).toMatch(/You have no reports yet|Your recent reports/);
  });

  it('hands to a person when asked; the help team sees it with a ticket', async () => {
    const r = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'My withdrawal is missing, I want to talk to a person', conversationId: chat }).expect(201)).body;
    expect(r.state).toBe('waiting_human');
    expect(r.messages.at(-1).body).toMatch(/passed this to a person/);
    await http.get('/admin/support/chats').set(as('citizen')).expect(403);
    await http.get('/admin/support/chats').set(as('platformFinance')).expect(403);
    const inbox = (await http.get('/admin/support/chats').set(as('platformSupport')).expect(200)).body;
    expect(inbox.items[0]).toMatchObject({ id: chat, state: 'waiting_human', person: 'Ada Obi' });
    const c = (await http.get(`/admin/support/chats/${chat}`).set(as('platformSupport')).expect(200)).body;
    expect(c.ticket).toMatch(/^S-\d{6}$/);
    expect((await http.get('/me/notifications').set(as('platformSupport'))).body.items.some((n: any) => n.type === 'help_chat_handoff')).toBe(true);
  });

  it('while a person has the chat the assistant stays quiet; replies and notes', async () => {
    await http.post(`/admin/support/chats/${chat}/note`).set(as('platformSupport')).send({ body: 'Checked: transfer pending at the bank.' }).expect(201);
    await http.post(`/admin/support/chats/${chat}/reply`).set(as('platformSupport')).send({ body: 'Your withdrawal is with the bank and will arrive today.' }).expect(201);
    const mine = (await http.get(`/me/help/chat/${chat}`).set(as('citizen')).expect(200)).body;
    expect(mine.state).toBe('human');
    expect(mine.messages.some((m: any) => m.role === 'note')).toBe(false);
    expect(mine.messages.at(-1)).toMatchObject({ role: 'agent', author: 'Ifeoma Support' });
    const r = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'Thank you!', conversationId: chat }).expect(201)).body;
    expect(r.messages.map((m: any) => m.role)).toEqual(['user']);
    const since = (await http.get(`/me/help/chat/${chat}?after=${r.messages[0].id}`).set(as('citizen')).expect(200)).body;
    expect(since.messages).toEqual([]);
  });

  it('hand back to the assistant, then close; someone else cannot read the chat', async () => {
    await http.post(`/admin/support/chats/${chat}/release`).set(as('platformSupport')).expect(201);
    const r = (await http.post('/me/help/chat').set(as('citizen')).send({ message: 'How do I appeal a fine?', conversationId: chat }).expect(201)).body;
    expect(r.messages.at(-1).role).toBe('bot');
    await http.get(`/me/help/chat/${chat}`).set(as('neighbour')).expect(404);
    await http.post(`/me/help/chat/${chat}/close`).set(as('citizen')).send({ rating: 5 }).expect(201);
    expect((await http.get('/me/help/chat').set(as('citizen'))).body).toEqual({});
    const officer = (await http.post('/me/help/chat').set(as('officer')).send({ message: 'How do I take a statement in person?' }).expect(201)).body;
    expect(officer.messages.at(-1).body).toMatch(/code sent to their phone|in person/i);
  });
});
