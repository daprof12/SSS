// Stolen-item registry: item types, my items, stolen reports, buyer checks and the police queue.
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
let seed: { users: Record<string, string>; agencyId: string; fermaId: string };
const t: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
let n = 0;
const ref = () => `item-${Date.now()}-${++n}`;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

// Valid IMEIs (Luhn) not used by the demo data.
const IMEI_A = '490154203237518';
const IMEI_B = '353918057381234';
const IMEI_C = '012345678901237';
const PDF = Buffer.from('%PDF-1.4\n% receipt\n%%EOF\n');

beforeAll(async () => {
  execSync(`node ${join(__dirname, '../../../scripts/migrate.mjs')} --reset`, { stdio: 'ignore' });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  await app.listen(0);
  http = request(app.getHttpServer());
  db = app.get(Db);
  seed = (await http.post('/dev/seed').expect(201)).body;
  for (const [k, id] of Object.entries(seed.users)) t[k] = (await http.post('/dev/token').send({ userId: id }).expect(201)).body.token;
});
afterAll(async () => {
  await app?.close();
});

const register = (who: string, body: Record<string, unknown>) => http.post('/me/items').set(as(who)).send({ typeCode: 'phone', make: 'Tecno', model: 'Spark 10', ...body });
const report = (who: string, body: Record<string, unknown>) => http.post('/stolen-reports').set(as(who)).send({ stolenOn: today(), postcode: 'CD34E', clientRef: ref(), ...body });
const check = (who: string, body: Record<string, unknown>) => http.post('/item-checks').set(as(who)).send({ typeCode: 'phone', context: 'buying', postcode: 'EF56G', ...body });
const police = (path: string) => http.get(`/agencies/${seed.agencyId}${path}`).set(as('agencyAdmin'));
const act = (caseId: string, body: Record<string, unknown>) => http.post(`/agencies/${seed.agencyId}/stolen/${caseId}/actions`).set(as('agencyAdmin')).send(body);
const attach = async (who: string, ownerType: string, ownerId: string, bytes: Buffer, contentType: string, extra: Record<string, unknown> = {}) => {
  const reg = (await http.post('/media').set(as(who)).send({ ownerType, ownerId, contentType, sizeBytes: bytes.length, ...extra }).expect(201)).body;
  return http.put(reg.uploadUrl).set(as(who)).set('Content-Type', contentType).send(bytes);
};

const TYPE = {
  label: 'Motorbike',
  icon: 'road',
  identifierLabel: 'Frame number',
  identifierHint: 'Stamped on the frame by the handlebars.',
  rule: { minLength: 8, maxLength: 17, charset: 'alnum', checksum: 'none', pattern: null },
  documents: [{ code: 'papers', label: 'Vehicle papers', required: true }],
  active: true,
  sort: 40,
};

describe('item types', () => {
  it('lists the built-in types with how each identifier is checked', async () => {
    const types = (await http.get('/item-types').set(as('citizen')).expect(200)).body;
    expect(types.map((x: any) => x.code)).toEqual(['phone', 'car', 'laptop']);
    expect(types[0]).toMatchObject({ identifierLabel: 'IMEI', rule: { minLength: 15, maxLength: 15, charset: 'digits', checksum: 'luhn' }, documents: [{ code: 'receipt', required: true }] });
  });

  it('lets platform admins add and change a type, and nobody else', async () => {
    await http.post('/admin/item-types').set(as('citizen')).send({ code: 'bike', ...TYPE }).expect(403);
    await http.post('/admin/item-types').set(as('agencyAdmin')).send({ code: 'bike', ...TYPE }).expect(403);
    const bad = await http.post('/admin/item-types').set(as('platformAdmin')).send({ code: 'bike', ...TYPE, rule: { ...TYPE.rule, checksum: 'luhn' } }).expect(422);
    expect(bad.body.fields).toEqual([{ field: 'rule', message: 'A Luhn check needs digits only.' }]);
    expect((await http.post('/admin/item-types').set(as('platformAdmin')).send({ code: 'Bike!', ...TYPE }).expect(400)).body.fields[0].field).toBe('code');

    await http.post('/admin/item-types').set(as('platformAdmin')).send({ code: 'motorbike', ...TYPE }).expect(201);
    await http.post('/admin/item-types').set(as('platformAdmin')).send({ code: 'motorbike', ...TYPE }).expect(409);
    expect((await http.get('/item-types').set(as('citizen'))).body.map((x: any) => x.code)).toContain('motorbike');

    const r = (await register('citizen', { typeCode: 'motorbike', identifier: 'abc', make: 'Bajaj' }).expect(422)).body;
    expect(r.fields).toEqual([{ field: 'identifier', message: 'The Frame number is 8 to 17 characters long. This one has 3.' }]);

    await http.put('/admin/item-types/motorbike').set(as('platformAdmin')).send({ ...TYPE, active: false }).expect(200);
    expect((await http.get('/item-types').set(as('citizen'))).body.map((x: any) => x.code)).not.toContain('motorbike');
    const admin = (await http.get('/admin/item-types').set(as('platformAdmin')).expect(200)).body;
    expect(admin.find((x: any) => x.code === 'motorbike')).toMatchObject({ active: false, items: 0, openCases: 0 });
    expect((await register('citizen', { typeCode: 'motorbike', identifier: 'BAJ12345678' }).expect(422)).body.message).toBe('Choose what kind of item it is.');
  });
});

describe('my items', () => {
  it('checks the identifier with the States doc copy and keeps one clean form', async () => {
    expect((await register('citizen', { identifier: '490154203237519' }).expect(422)).body.fields).toEqual([{ field: 'identifier', message: 'This is not a valid IMEI. Check each digit again.' }]);
    const it1 = (await register('citizen', { identifier: '49 0154 2032 3751 8' }).expect(201)).body;
    expect(it1).toMatchObject({ identifier: IMEI_A, name: 'Tecno Spark 10', proofComplete: false, documents: [{ code: 'receipt', required: true, provided: false }], canReport: true });
    expect((await register('citizen', { identifier: IMEI_A }).expect(409)).body).toMatchObject({ code: 'already_registered', itemId: it1.id });
    expect((await register('neighbour', { identifier: IMEI_A }).expect(409)).body.code).toBe('registered_elsewhere');

    // Proof: a receipt as a PDF. Tips never take documents.
    await attach('citizen', 'owned_item', it1.id, PDF, 'application/pdf', { docCode: 'receipt' }).then((r) => expect(r.status).toBe(200));
    expect((await http.get(`/me/items/${it1.id}`).set(as('citizen'))).body).toMatchObject({ proofComplete: true, documents: [{ provided: true }] });
    const tip = (await http.post('/tips').set(as('citizen')).send({ category: 'human_trafficking', description: 'Girls are kept in a house on Allen and moved at night.', clientRef: ref(), postcode: 'CD34E' }).expect(201)).body;
    await http.post('/media').set(as('citizen')).send({ ownerType: 'tip', ownerId: tip.id, contentType: 'application/pdf', sizeBytes: 20 }).expect(422);
    // Another person cannot see the item or its files.
    await http.get(`/me/items/${it1.id}`).set(as('neighbour')).expect(404);
    await http.get(`/attachments?ownerType=owned_item&ownerId=${it1.id}`).set(as('neighbour')).expect(404);

    const mine = (await http.get('/me/items').set(as('citizen')).expect(200)).body;
    expect(mine.find((x: any) => x.id === it1.id)).toMatchObject({ typeLabel: 'Phone', stolen: null, proofComplete: true });
  });
});

describe('stolen reports and buyer checks', () => {
  let itemId: string;
  let caseId: string;
  let checkId: string;

  it('reports a registered item stolen in one step and sends it to the police', async () => {
    itemId = (await register('citizen', { identifier: IMEI_B, make: 'Infinix', model: 'Hot 30' }).expect(201)).body.id;
    expect((await report('citizen', { itemId, postcode: undefined }).expect(422)).body.message).toBe('Add where it was stolen: your location or a postcode.');
    expect((await report('citizen', { itemId, stolenOn: '2999-01-01' }).expect(422)).body.fields[0].field).toBe('stolenOn');
    const clientRef = ref();
    const r = (await report('citizen', { itemId, clientRef, circumstances: 'Taken from my bag in a danfo.' }).expect(201)).body;
    expect(r).toMatchObject({ publicNo: expect.stringMatching(/^S-\d{6}$/), routedTo: 'Nigeria Police Force (demo)', state: 'reported' });
    caseId = r.id;
    expect((await report('citizen', { itemId, clientRef }).expect(201)).body).toMatchObject({ id: caseId, duplicate: true });
    expect((await report('citizen', { itemId }).expect(409)).body).toMatchObject({ code: 'already_reported', caseId });

    const d = (await http.get(`/stolen-reports/${caseId}`).set(as('citizen')).expect(200)).body;
    expect(d.status.chip).toBe('Reported');
    expect(d.steps.map((s: any) => [s.label, s.done])).toEqual([
      ['Reported', true],
      ['Police investigating', false],
      ['Item located', false],
      ['Recovered', false],
      ['Returned to you', false],
    ]);
    await http.get(`/stolen-reports/${caseId}`).set(as('neighbour')).expect(404);
    const note = (await http.get('/me/notifications').set(as('agencyAdmin'))).body.items.find((x: any) => x.type === 'stolen_new');
    expect(note).toMatchObject({ title: 'Stolen item reported', link: `/agency/stolen/${caseId}` });
  });

  it('reports an item that was never registered, with its identifier', async () => {
    const r = (await report('neighbour', { item: { typeCode: 'laptop', identifier: 'c02-xk19-zz', make: 'Apple', model: 'MacBook Air' } }).expect(201)).body;
    const d = (await http.get(`/stolen-reports/${r.id}`).set(as('neighbour'))).body;
    expect(d).toMatchObject({ identifier: 'C02XK19ZZ', name: 'Apple MacBook Air' });
    expect((await check('citizen', { typeCode: 'laptop', identifier: 'C02 XK19 ZZ' }).expect(201)).body.result).toBe('stolen');
    // It is in the registry for checks, not in "My items" as registered.
    const mine = (await http.get('/me/items').set(as('neighbour'))).body.find((x: any) => x.identifier === 'C02XK19ZZ');
    expect(mine).toMatchObject({ registered: false, stolen: { state: 'reported' } });
  });

  it('tells a buyer it is clean or stolen, logs the match with where, and tells the owner and the police', async () => {
    expect((await check('neighbour', { identifier: '12345' }).expect(422)).body.fields).toEqual([{ field: 'identifier', message: 'The IMEI is 15 characters long. This one has 5.' }]);
    const clean = (await check('neighbour', { identifier: IMEI_C }).expect(201)).body;
    expect(clean).toMatchObject({ result: 'clean', checkNo: expect.stringMatching(/^C-\d{6}$/), stolen: null });

    const hit = (await check('neighbour', { identifier: IMEI_B, lat: 6.5096, lng: 3.3712, postcode: undefined, accuracy: 12 }).expect(201)).body;
    expect(hit).toMatchObject({ result: 'stolen', stolen: { item: 'Infinix Hot 30', yours: false } });
    checkId = hit.id;
    const row = (await db.query(`select result, case_id, context, accuracy_m, location_id is not null as placed, agency_id from item_checks where id = $1`, [checkId])).rows[0];
    expect(row).toMatchObject({ result: 'stolen', case_id: caseId, context: 'buying', accuracy_m: 12, placed: true, agency_id: seed.agencyId });

    const owner = (await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'stolen_match');
    expect(owner).toMatchObject({ title: 'Someone checked your stolen item', link: `/stolen/${caseId}` });
    expect(owner.body).not.toMatch(/Chidi|Neighbour/i);
    expect((await http.get(`/stolen-reports/${caseId}`).set(as('citizen'))).body.matches).toMatchObject({ count: 1, last: { area: 'Yaba central' } });
    const p = (await http.get('/me/notifications').set(as('agencyAdmin'))).body.items.find((x: any) => x.type === 'stolen_match');
    expect(p.link).toBe(`/agency/stolen/${caseId}`);

    // The buyer adds who is selling it; only the buyer can.
    await http.post(`/item-checks/${checkId}/details`).set(as('neighbour')).send({}).expect(422);
    await http.post(`/item-checks/${checkId}/details`).set(as('citizen')).send({ note: 'x' }).expect(404);
    await http.post(`/item-checks/${checkId}/details`).set(as('neighbour')).send({ sellerName: 'Emeka', sellerPhone: '0803 111 2222', note: 'At the Sabo market gate.' }).expect(201);
    await http.post(`/item-checks/${clean.id}/details`).set(as('neighbour')).send({ note: 'Nothing' }).expect(409);

    // The buyer keeps every reference as proof they checked.
    const mine = (await http.get('/me/item-checks').set(as('neighbour')).expect(200)).body;
    expect(mine.slice(0, 2).map((x: any) => x.result)).toEqual(['stolen', 'clean']);
    // Events and checks are append-only evidence.
    await expect(db.query(`update item_checks set result = 'clean' where id = $1`, [checkId])).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from stolen_case_events where case_id = $1`, [caseId])).rejects.toThrow(/append-only/);
  });

  it('limits checks per hour so the registry cannot be scraped', async () => {
    const who = seed.users.officer2!;
    await db.query(
      `insert into item_checks (check_no, checker_id, type_code, identifier, result) select 'C-L' || g, $1, 'phone', $2, 'clean' from generate_series(1, 30) g`,
      [who, IMEI_C],
    );
    expect((await check('officer2', { identifier: IMEI_C }).expect(429)).body.code).toBe('too_many_checks');
  });

  it('shows the police the case and matches with the place filter, and moves it to recovery', async () => {
    const open = (await police('/stolen?tab=open').expect(200)).body;
    expect(open.find((x: any) => x.id === caseId)).toMatchObject({ name: 'Infinix Hot 30', identifier: IMEI_B, matches: 1, newMatches: 1, postcode: 'CD34E', area: 'Allen, Ikeja' });
    // NIPOST levels: LGA Ikeja holds the case; Yaba does not.
    expect((await police('/stolen?tab=open&lga=LA-IKJ')).body.some((x: any) => x.id === caseId)).toBe(true);
    expect((await police('/stolen?tab=open&lga=LA-YAB')).body.some((x: any) => x.id === caseId)).toBe(false);
    expect((await police('/stolen?tab=open&postcode=CD3')).body.some((x: any) => x.id === caseId)).toBe(true);

    const matches = (await police('/stolen-matches?tab=new').expect(200)).body;
    const m = matches.find((x: any) => x.id === checkId);
    expect(m).toMatchObject({ caseId, checker: expect.any(String), checkerPhone: expect.stringMatching(/^\+234/), area: 'Yaba central', details: 1, reviewed: false });
    expect((await police('/stolen-matches?tab=new&area=LA-IKJ-01-ALN')).body.some((x: any) => x.id === checkId)).toBe(false);

    const d = (await police(`/stolen/${caseId}`).expect(200)).body;
    expect(d).toMatchObject({ ours: true, owner: { name: expect.any(String) }, ownershipConflict: false });
    expect(d.actions.sort()).toEqual(['close', 'investigate', 'locate']);
    expect(d.matches[0].sellerDetails).toEqual([{ sellerName: 'Emeka', sellerPhone: '0803 111 2222', note: 'At the Sabo market gate.', at: expect.any(String) }]);

    // Other agencies and other people cannot see it.
    await http.get(`/agencies/${seed.fermaId}/stolen`).set(as('fermaAdmin')).expect(409);
    await http.get(`/agencies/${seed.agencyId}/stolen`).set(as('citizen')).expect(404);

    // Review the match, then move the case through recovery.
    const review = (body: Record<string, unknown>) => http.post(`/agencies/${seed.agencyId}/stolen/${caseId}/matches/${checkId}/review`).set(as('agencyAdmin')).send(body);
    await review({ outcome: 'dismissed' }).expect(422);
    await review({ outcome: 'followed_up', note: 'Officers sent to Sabo market.' }).expect(201);
    await review({ outcome: 'followed_up' }).expect(409);
    expect((await police('/stolen-matches?tab=new')).body.some((x: any) => x.id === checkId)).toBe(false);

    await act(caseId, { event: 'investigate', note: 'Seller traced.' }).expect(201);
    await act(caseId, { event: 'recover' }).expect(422);
    await act(caseId, { event: 'return_to_owner' }).expect(409);
    await act(caseId, { event: 'recover', note: 'Recovered from a stall at Sabo market.' }).expect(201);
    const owner = (await http.get(`/stolen-reports/${caseId}`).set(as('citizen'))).body;
    expect(owner.status.chip).toBe('Recovered');
    expect(owner.steps.filter((s: any) => s.done).map((s: any) => s.label)).toEqual(['Reported', 'Police investigating', 'Recovered']);
    expect(owner.timeline.map((e: any) => e.label)).toEqual(['Reported stolen', 'Someone checked it before buying', 'Police started investigating', 'Police recovered the item']);
    expect(JSON.stringify(owner)).not.toContain('Emeka');
    expect((await http.get('/me/notifications').set(as('citizen'))).body.items.find((x: any) => x.type === 'stolen_recover').title).toBe('Your item was recovered');

    // Recovered: no longer wanted, so a check comes back clean.
    expect((await check('neighbour', { identifier: IMEI_B }).expect(201)).body.result).toBe('clean');
    await act(caseId, { event: 'return_to_owner' }).expect(201);
    expect((await police('/stolen?tab=closed')).body.find((x: any) => x.id === caseId).stateLabel).toBe('Returned to owner');
    // The item can be reported again if it is stolen again.
    expect((await http.get(`/me/items/${itemId}`).set(as('citizen'))).body.canReport).toBe(true);
  });

  it('lets the owner withdraw a report when they get the item back', async () => {
    const id = (await register('neighbour', { typeCode: 'car', identifier: '1HGCM82633A004352', make: 'Honda', model: 'Accord' }).expect(201)).body.id;
    const k = (await report('neighbour', { itemId: id }).expect(201)).body;
    await http.delete(`/me/items/${id}`).set(as('neighbour')).expect(409);
    expect((await check('citizen', { typeCode: 'car', identifier: '1hgcm82633a004352' }).expect(201)).body.result).toBe('stolen');
    await http.post(`/stolen-reports/${k.id}/withdraw`).set(as('citizen')).send({ reason: 'found' }).expect(404);
    await http.post(`/stolen-reports/${k.id}/withdraw`).set(as('neighbour')).send({ reason: 'found' }).expect(201);
    await http.post(`/stolen-reports/${k.id}/withdraw`).set(as('neighbour')).send({ reason: 'found' }).expect(409);
    expect((await check('citizen', { typeCode: 'car', identifier: '1HGCM82633A004352' }).expect(201)).body.result).toBe('clean');
    await http.delete(`/me/items/${id}`).set(as('neighbour')).expect(200);
    await http.get(`/me/items/${id}`).set(as('neighbour')).expect(404);
  });
});
