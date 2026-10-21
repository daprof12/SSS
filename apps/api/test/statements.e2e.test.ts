// Statements (B7), the station's review of a false alarm before any fine (B8), and help replies.
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
let users: Record<string, string>;
let stationId: string;
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ref = () => `st-${Date.now()}-${++n}`;
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(50);
    v = await fn();
  }
  return v;
}
const view = async (who: string, id: string) => (await http.get(`/incidents/${id}`).set(as(who))).body;

/** A robbery the officer reaches; `close` ends it valid or unfounded, or leaves it on scene. */
async function onScene(reporter: string, type = 'robbery') {
  const id = (await http.post('/incidents').set(as(reporter)).send({ type, postcode: 'AB12C', clientRef: ref() }).expect(201)).body.id;
  await waitFor(() => view(reporter, id), (x) => x.state === 'offered');
  let lead = '';
  for (const w of ['officer', 'officer2']) if ((await view(w, id)).view === 'officer') lead = w;
  await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event: 'accept' }).expect(201);
  for (const event of ['start_route', 'arrive']) await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event }).expect(201);
  return { id, lead };
}
async function closeUnfounded(id: string, lead: string) {
  await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event: 'begin_close' }).expect(201);
  await http.post(`/incidents/${id}/actions`).set(as(lead)).send({ event: 'close_unfounded', outcomeCode: 'no_incident', reason: 'Nobody there and nothing taken.' }).expect(201);
}

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', CANCEL_WINDOW_MS: '120' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  const seed = (await http.post('/dev/seed').expect(201)).body;
  users = seed.users;
  stationId = seed.stationId;
  for (const [k, id] of Object.entries(users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
  for (const [u, lng, lat] of [
    [users.officer, 3.352, 6.6015],
    [users.officer2, 3.36, 6.61],
  ] as const) {
    await db.query(`update officers set on_duty = true, badge_status = 'verified', station_id = $1, last_location = st_setsrid(st_makepoint($3, $4), 4326)::geography where user_id = $2`, [stationId, u, lng, lat]);
  }
  await http.put('/me/pin').set(as('citizen')).send({ pin: '7302' }).expect(200);
});
afterAll(async () => {
  await app?.close();
});

describe('statements', () => {
  let incident = '';
  let lead = '';
  let sid = '';
  it('an officer on scene asks the reporter; the reporter is told', async () => {
    ({ id: incident, lead } = await onScene('citizen'));
    await http.post(`/incidents/${incident}/statements`).set(as('neighbour')).send({}).expect(404);
    const r = (await http.post(`/incidents/${incident}/statements`).set(as(lead)).send({ note: 'What did you see from the window?' }).expect(201)).body;
    sid = r.id;
    expect(r.number).toMatch(/^ST-\d{6}$/);
    expect((await http.post(`/incidents/${incident}/statements`).set(as('head')).send({}).expect(409)).body.message).toMatch(/^A statement was already asked for: ST-\d{6}\./);
    const note = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'statement_requested');
    expect(note.body).toBe('Station 4 Ikeja asked for your statement as complainant on a robbery report. Speak or type it in the language you are most comfortable in.');
    expect((await http.get('/me/statements').set(as('citizen'))).body[0]).toMatchObject({ id: sid, state: 'requested', stateLabel: 'Waiting for you', report: 'Robbery, AB12C' });
    expect((await view('citizen', incident)).timeline.find((e: any) => e.label === 'Statement requested')).toBeTruthy();
  });

  it('records in Hausa, makes an English record to correct, and signs with the PIN into a sealed version', async () => {
    const d = (await http.put(`/me/statements/${sid}/draft`).set(as('citizen')).send({ language: 'ha', original: 'Na ga mutane biyu sun shiga gidan Musa da karfe 9:30.' }).expect(200)).body;
    expect(d.state).toBe('draft');
    expect(d.draft.english).toMatch(/^\[Machine draft from Hausa; check every line\]/);
    expect(d.draft.flagged).toEqual(expect.arrayContaining(['Musa', '9:30']));
    const fixed = 'I saw two people enter Musa’s house at 9:30.';
    await http.put(`/me/statements/${sid}/draft`).set(as('citizen')).send({ language: 'ha', original: d.draft.original, english: fixed }).expect(200);
    expect((await http.get(`/me/statements/${sid}`).set(as('citizen'))).body.draft.english).toBe(fixed);

    expect((await http.post(`/me/statements/${sid}/sign`).set(as('citizen')).send({ pin: '7302', confirm: false }).expect(422)).body.message).toBe('Confirm the English says what you meant.');
    expect((await http.post(`/me/statements/${sid}/sign`).set(as('citizen')).send({ pin: '1111', confirm: true }).expect(422)).body.code).toBe('pin_wrong');
    const s = (await http.post(`/me/statements/${sid}/sign`).set(as('citizen')).send({ pin: '7302', confirm: true }).expect(201)).body;
    expect(s).toMatchObject({ version: 1, message: 'Sealed and sent to Station 4 Ikeja.' });
    expect(s.seal).toMatch(/^[0-9A-F]{8}$/);
    const mine = (await http.get(`/me/statements/${sid}`).set(as('citizen'))).body;
    expect(mine).toMatchObject({ state: 'signed', draft: null, latest: { version: 1, of: 1, seal: s.seal } });
    expect(mine.versions[0]).toMatchObject({ languageName: 'Hausa', english: fixed, signedWith: 'pin' });
    // Sealed rows cannot change.
    await expect(db.query(`update statement_versions set english_text = 'x' where statement_id = $1`, [sid])).rejects.toThrow();
    await http.put(`/me/statements/${sid}/draft`).set(as('citizen')).send({ language: 'en', original: 'changed my mind' }).expect(409);
    const head = (await http.get('/me/notifications').set(as('head'))).body.items.find((x: any) => x.type === 'statement_signed');
    expect(head.body).toMatch(/^ST-\d{6}, statement of complainant for Robbery, AB12C, was signed\.$/);
  });

  it('the station reads it (logged), downloads the PDF, asks for more; the reporter signs version 2 and v1 stays', async () => {
    await http.get(`/statements/${sid}`).set(as('neighbour')).expect(404);
    const v = (await http.get(`/statements/${sid}`).set(as('head')).expect(200)).body;
    expect(v).toMatchObject({ reporter: 'Ada Obi', latest: { version: 1 }, requestNote: 'What did you see from the window?' });
    const pdf = await http.get(`/statements/${sid}/statement.pdf`).set(as('head')).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await http.post(`/statements/${sid}/request-change`).set(as('head')).send({ note: 'x' }).expect(422)).body.message).toBe('Say what is missing, so the reporter knows what to add.');
    await http.post(`/statements/${sid}/request-change`).set(as('head')).send({ note: 'What were they wearing?' }).expect(201);
    const c = (await http.get(`/me/statements/${sid}`).set(as('citizen'))).body;
    expect(c).toMatchObject({ state: 'change_requested', changeNote: 'What were they wearing?' });
    expect(c.draft.english).toBe('I saw two people enter Musa’s house at 9:30.');
    await http
      .put(`/me/statements/${sid}/draft`)
      .set(as('citizen'))
      .send({ language: 'en', original: 'I saw two people enter Musa’s house at 9:30. Both wore black hoods.', english: 'I saw two people enter Musa’s house at 9:30. Both wore black hoods.' })
      .expect(200);
    expect((await http.post(`/me/statements/${sid}/sign`).set(as('citizen')).send({ pin: '7302', confirm: true }).expect(201)).body.version).toBe(2);
    const after = (await http.get(`/statements/${sid}`).set(as('head'))).body;
    expect(after.versions.map((x: any) => x.version)).toEqual([1, 2]);
    expect(after.versions[0].english).toBe('I saw two people enter Musa’s house at 9:30.');
    expect(after.access.map((a: any) => a.action)).toEqual(expect.arrayContaining(['opened', 'downloaded', 'detail_requested']));
    await http.post(`/statements/${sid}/translator-check`).set(as('head')).send({ note: 'Check the time said.' }).expect(201);
    expect((await http.get('/admin/support').set(as('platformAdmin'))).body.translatorChecks[0]).toMatchObject({ id: sid, note: 'Check the time said.' });
  });

  it('shares a view-only copy for 7 days', async () => {
    const s = (await http.post(`/me/statements/${sid}/share`).set(as('citizen')).expect(201)).body;
    const shared = (await http.get(`/shared/statements/${s.token}`).expect(200)).body;
    expect(shared).toMatchObject({ version: 2, station: 'Station 4 Ikeja' });
    await http.get(`/shared/statements/${'x'.repeat(32)}`).expect(404);
    // Close the robbery so later reports at this building are not merged into it.
    await http.post(`/incidents/${incident}/actions`).set(as(lead)).send({ event: 'begin_close' }).expect(201);
    await http.post(`/incidents/${incident}/actions`).set(as(lead)).send({ event: 'close_valid', outcomeCode: 'arrest' }).expect(201);
  });
});

describe('false alarm: station review before any fine', () => {
  it('waits for the station; overturning leaves the reporter untouched', async () => {
    const { id, lead } = await onScene('neighbour', 'riot');
    await closeUnfounded(id, lead);
    const q = (await http.get('/me/station/false-alarms').set(as('head')).expect(200)).body;
    expect(q.find((x: any) => x.incidentId === id)).toMatchObject({ label: 'Riot, AB12C', officerNote: 'Nobody there and nothing taken.' });
    expect((await http.get('/me/fines').set(as('neighbour'))).body.warnings).toHaveLength(0);
    const h = (await http.get('/me/notifications').set(as('head'))).body.items.find((x: any) => x.type === 'false_alarm_review');
    expect(h.body).toMatch(/Confirm or overturn it within 48 hours; after that it goes ahead\.$/);
    await http.get('/me/station/false-alarms').set(as('citizen')).expect(403);
    expect((await http.post(`/me/station/false-alarms/${id}/review`).set(as('head')).send({ decision: 'overturn' }).expect(422)).body.message).toBe('Say why it was not a false alarm.');
    await http.post(`/me/station/false-alarms/${id}/review`).set(as('head')).send({ decision: 'overturn', note: 'The neighbour confirmed a break-in.' }).expect(201);
    await http.post(`/me/station/false-alarms/${id}/review`).set(as('head')).send({ decision: 'confirm' }).expect(409);
    expect((await http.get('/me/fines').set(as('neighbour'))).body).toMatchObject({ warnings: [], fines: [] });
  });

  it('goes ahead by itself after 48 hours', async () => {
    const { id, lead } = await onScene('neighbour', 'riot');
    await closeUnfounded(id, lead);
    await db.query(`update false_alarm_cases set review_due_at = now() - interval '1 minute' where incident_id = $1`, [id]);
    expect((await http.post('/admin/jobs/run').set(as('platformAdmin')).expect(201)).body.falseAlarmsConfirmed).toBe(1);
    expect((await http.get('/me/fines').set(as('neighbour'))).body.warnings).toHaveLength(1);
  });
});

describe('help replies', () => {
  it('staff reply from the inbox; the person sees it and is told', async () => {
    const tk = (await http.post('/me/support/tickets').set(as('citizen')).send({ topic: 'money', body: 'My refund did not arrive yet.' }).expect(201)).body;
    await http.get('/admin/support').set(as('citizen')).expect(403);
    const inbox = (await http.get('/admin/support').set(as('platformAdmin')).expect(200)).body;
    expect(inbox.items[0]).toMatchObject({ id: tk.id, from: 'Ada Obi', state: 'open' });
    expect((await http.post(`/admin/support/${tk.id}/reply`).set(as('platformAdmin')).send({ reply: 'ok' }).expect(400)).body.fields[0].message).toBe('Write a reply the person will read.');
    await http.post(`/admin/support/${tk.id}/reply`).set(as('platformAdmin')).send({ reply: 'It was sent today; banks take up to 24 hours.' }).expect(200);
    const mine = (await http.get('/me/support').set(as('citizen'))).body.tickets.find((x: any) => x.id === tk.id);
    expect(mine).toMatchObject({ state: 'answered', reply: 'It was sent today; banks take up to 24 hours.' });
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'support_reply').body).toMatch(/^About S-\d{6}: It was sent today/);
  });
});

describe('statements from anyone on a report', () => {
  let incident = '';
  let lead = '';
  const lastSms = async (to: string) => ((await http.get('/dev/sms')).body as any[]).filter((m) => m.to === to).pop();

  it('lists who can be asked: the reporter, people who joined, the officers on it', async () => {
    ({ id: incident, lead } = await onScene('citizen'));
    const r = (await http.get(`/incidents/${incident}/statement-parties`).set(as('head')).expect(200)).body;
    expect(r.parties.map((x: any) => x.role)).toEqual(['complainant', 'officer']);
    await http.get(`/incidents/${incident}/statement-parties`).set(as('neighbour')).expect(404);
  });

  it('the agency asks a witness who is not on the app; they are created and texted', async () => {
    const r = (
      await http.post(`/incidents/${incident}/statements`).set(as('agencyAdmin')).send({ role: 'witness', phone: '+2348035550101', name: 'Musa Bello', note: 'You saw the car leave.' }).expect(201)
    ).body;
    expect(r.message).toBe('Asked. They were sent a text to sign in and give it.');
    expect((await lastSms('+2348035550101')).body).toMatch(/asked for your statement \(ST-\d{6}\)/);
    await http.post(`/incidents/${incident}/statements`).set(as('agencyAdmin')).send({ role: 'witness', phone: '+2348035550101' }).expect(409);
  });

  it('an officer writes their own statement and signs it with their PIN', async () => {
    const r = (await http.post(`/incidents/${incident}/statements`).set(as(lead)).send({ role: 'officer', userId: users[lead] }).expect(201)).body;
    expect(r.message).toBe('Your statement is ready to write.');
    await http.put(`/me/statements/${r.id}/draft`).set(as(lead)).send({ language: 'en', original: 'I arrived at 10:05 and found the gate open and the car gone.' }).expect(200);
    await http.put('/me/pin').set(as(lead)).send({ pin: '5821' }).expect(200);
    await http.post(`/me/statements/${r.id}/sign`).set(as(lead)).send({ pin: '5821', confirm: true }).expect(201);
    const v = (await http.get(`/statements/${r.id}`).set(as('head')).expect(200)).body;
    expect(v).toMatchObject({ role: 'officer', form: "Officer's statement", state: 'signed' });
  });

  it('a suspect: taken in person after the caution, with someone present, confirmed with a code to their phone', async () => {
    const bad = (await http.post(`/incidents/${incident}/statements`).set(as(lead)).send({ role: 'suspect', phone: '+2348035550202', name: 'Tunde Ade' }).expect(422)).body;
    expect(bad.fields[0].field).toBe('presentName');
    const r = (
      await http
        .post(`/incidents/${incident}/statements`)
        .set(as(lead))
        .send({ role: 'suspect', phone: '+2348035550202', name: 'Tunde Ade', presentName: 'Barr. Ngozi Eze', presentRelation: 'Lawyer', place: 'Station 4 Ikeja' })
        .expect(201)
    ).body;
    expect(r.mode).toBe('in_person');
    await http.put(`/statements/${r.id}/in-person/draft`).set(as(lead)).send({ language: 'pcm', original: 'I no dey there that night, I dey my sister house for Yaba.' }).expect(200);
    expect((await http.post(`/statements/${r.id}/in-person/send-code`).set(as(lead)).expect(422)).body.code).toBe('caution_first');
    await http.post(`/statements/${r.id}/in-person/caution`).set(as(lead)).expect(201);
    expect((await http.post(`/statements/${r.id}/in-person/send-code`).set(as(lead)).expect(201)).body.message).toMatch(/ending 0202/);
    const code = (await lastSms('+2348035550202')).body.match(/is (\d{6})/)[1];
    const wrong = code === '000000' ? '111111' : '000000';
    await http.post(`/statements/${r.id}/in-person/confirm`).set(as(lead)).send({ code: wrong, confirm: true }).expect(422);
    expect((await http.post(`/statements/${r.id}/in-person/confirm`).set(as(lead)).send({ code, confirm: true }).expect(201)).body.version).toBe(1);
    const v = (await http.get(`/statements/${r.id}`).set(as('agencyAdmin')).expect(200)).body;
    expect(v).toMatchObject({ form: 'Cautionary statement', mode: 'in_person', present: { name: 'Barr. Ngozi Eze', relation: 'Lawyer' } });
    expect(v.caution.givenAt).toBeTruthy();
    expect(v.versions[0]).toMatchObject({ signedWith: 'phone_code', present: 'Barr. Ngozi Eze' });
    const pdf = await http.get(`/statements/${r.id}/statement.pdf`).set(as('head')).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('the station and the agency list every statement on their reports, filtered by role and place', async () => {
    const s = (await http.get('/me/station/statements').set(as('head')).expect(200)).body;
    expect(s.items.filter((x: any) => x.report.id === incident).map((x: any) => x.role).sort()).toEqual(['officer', 'suspect', 'witness']);
    expect((await http.get('/me/station/statements?role=suspect').set(as('head'))).body.items.every((x: any) => x.role === 'suspect')).toBe(true);
    const a = (await http.get(`/agencies/${(await db.query(`select agency_id from stations where id = $1`, [stationId])).rows[0].agency_id}/statements?lga=LA-IKJ`).set(as('agencyAdmin')).expect(200)).body;
    expect(a.counts.signed).toBeGreaterThanOrEqual(2);
    await http.get('/me/station/statements').set(as('officer')).expect(403);
    await http.get('/me/station/statements?state=FC').set(as('head')).expect(200);
  });
});
