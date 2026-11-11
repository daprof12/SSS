// Demo records for the agency and admin pages that otherwise start empty: public issues, statements,
// equipment, infrastructure assets, store stock and invoices. Each block runs once (it checks first).
import { createHash } from 'node:crypto';
import type { Queryable } from '../core/db';

interface Ids {
  citizen: string;
  neighbour: string;
  officer: string;
  officer2: string;
  head: string;
  agencyAdmin: string;
  fermaAdmin: string;
  platformAdmin: string;
}
interface Places {
  police: string;
  ferma: string;
  ikeja: string;
  yaba: string;
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** A building near Ikeja or Yaba, made once by postcode. */
async function place(c: Queryable, pc: string, address: string, area: [string, string, string, string], lat: number, lng: number) {
  const [lga, district, areaId, label] = area;
  return (
    await c.query(
      `insert into locations (postcode, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
       values ($1, $2, 'LA', $3, $4, $5, $6, st_setsrid(st_makepoint($8, $7), 4326)::geography)
       on conflict (postcode) do update set fetched_at = now() returning id`,
      [pc, address, lga, district, areaId, label, lat, lng],
    )
  ).rows[0].id as string;
}

export async function seedDemoData(c: Queryable, ids: Ids, at: Places) {
  const ALLEN: [string, string, string, string] = ['LA-IKJ', 'LA-IKJ-01', 'LA-IKJ-01-ALN', 'Allen, Ikeja'];
  const OPEBI: [string, string, string, string] = ['LA-IKJ', 'LA-IKJ-01', 'LA-IKJ-01-OPB', 'Opebi, Ikeja'];
  const YABA: [string, string, string, string] = ['LA-YAB', 'LA-YAB-02', 'LA-YAB-02-HMW', 'Yaba central'];
  const L = {
    allen: await place(c, 'CD34E', '34 Allen Avenue', ALLEN, 6.6008, 3.3528),
    opebi: await place(c, 'OP21K', '21 Opebi Road', OPEBI, 6.6052, 3.3602),
    toyin: await place(c, 'TY09M', '9 Toyin Street', ALLEN, 6.5995, 3.3489),
    yaba: await place(c, 'EF56G', '56 Herbert Macaulay Way', YABA, 6.5095, 3.3711),
    sabo: await place(c, 'SB14Q', '14 Sabo Market Road', YABA, 6.5071, 3.3769),
    ikorodu: await place(c, 'IK88R', '88 Ikorodu Road', YABA, 6.5139, 3.3802),
  };
  await issues(c, ids, at, L);
  await statements(c, ids, at, L);
  await equipment(c, ids, at);
  await assets(c, ids, at, L);
  await stock(c);
  await invoices(c, ids, at);
  await stolenItems(c, ids, at, L);
}

// ---------------------------------------------------------------- public issues
async function issues(c: Queryable, ids: Ids, at: Places, L: Record<string, string>) {
  if ((await c.query(`select 1 from issue_cases where public_no like 'P-9%' limit 1`)).rowCount) return;
  const rows: [string, string, string | null, string, string, string, number, number, string | null, string | null][] = [
    // no, category, agency, label, location, state, reports, days ago, fix note, subtype
    ['P-900101', 'road', at.ferma, 'FERMA (demo)', L.ikorodu!, 'in_progress', 14, 9, null, 'Pothole'],
    ['P-900102', 'road', at.ferma, 'FERMA (demo)', L.sabo!, 'assigned', 6, 4, null, 'Flooded'],
    ['P-900103', 'road', at.ferma, 'FERMA (demo)', L.yaba!, 'open', 3, 1, null, 'Collapsed road'],
    ['P-900104', 'road', at.ferma, 'FERMA (demo)', L.opebi!, 'fixed', 9, 21, 'Patched and resurfaced.', 'Pothole'],
    ['P-900105', 'road', at.ferma, 'FERMA (demo)', L.toyin!, 'reopened', 5, 12, 'Patched.', 'Open drain'],
    ['P-900201', 'one_chance', at.police, 'Nigeria Police Force (demo)', L.allen!, 'in_progress', 7, 3, null, 'Same vehicle again'],
    ['P-900202', 'one_chance', at.police, 'Nigeria Police Force (demo)', L.ikorodu!, 'open', 2, 0, null, 'Plate seen'],
    ['P-900203', 'camera_fault', at.police, 'Nigeria Police Force (demo)', L.allen!, 'awaiting_check', 4, 6, 'Lens cleaned and re-aimed.', 'Moved or covered'],
    ['P-900301', 'waste', null, 'NESREA or State EPA', L.sabo!, 'open', 11, 5, null, 'Illegal dumping'],
    ['P-900302', 'building', null, 'Building control', L.toyin!, 'open', 3, 2, null, 'Cracks'],
  ];
  const sev = ['small', 'dangerous', 'blocking'];
  const people = [ids.citizen, ids.neighbour];
  for (const [i, [no, cat, agency, label, loc, state, count, days, fix, subtype]] of rows.entries()) {
    const severity = sev[(i + count) % 3]!;
    const id = (
      await c.query(
        `insert into issue_cases (public_no, category, agency_id, agency_label, location_id, geom, state, severity, report_count, people_count, first_at, last_at, target_on, fix_note, fixed_at, station_id)
         select $1, $2, $3, $4, l.id, l.geom, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13 from locations l where l.id = $14 returning id`,
        [no, cat, agency, label, state, severity, count, ago(days), ago(Math.max(0, days - 1)), state === 'fixed' ? null : isoDay(new Date(Date.now() + 10 * DAY)), fix, state === 'fixed' ? ago(days - 5) : null, agency === at.police ? at.ikeja : null, loc],
      )
    ).rows[0].id;
    for (const [n, u] of people.slice(0, Math.min(2, count)).entries()) {
      await c.query(`insert into issue_reports (case_id, user_id, subtype, severity, description, created_at) values ($1, $2, $3, $4, $5, $6)`, [
        id,
        u,
        subtype,
        severity,
        n ? 'Still there this morning.' : `${subtype} here. People have been complaining for days.`,
        ago(days - n),
      ]);
    }
    const events: [string, string][] = [['reported', 'citizen']];
    if (['assigned', 'in_progress', 'awaiting_check', 'fixed', 'reopened'].includes(state)) events.push(['assign', 'agency']);
    if (['in_progress', 'awaiting_check', 'fixed', 'reopened'].includes(state)) events.push(['start', 'agency']);
    if (['awaiting_check', 'fixed', 'reopened'].includes(state)) events.push(['mark_fixed', 'agency']);
    if (state === 'reopened') events.push(['reopened', 'citizen']);
    for (const [n, [kind, actor]] of events.entries()) {
      await c.query(`insert into issue_events (case_id, kind, actor_kind, payload, at) values ($1, $2, $3, '{}', $4)`, [id, kind, actor, ago(days - n * 0.8)]);
    }
  }
}

// ---------------------------------------------------------------- statements
async function statements(c: Queryable, ids: Ids, at: Places, L: Record<string, string>) {
  if ((await c.query(`select 1 from statements where number like 'ST-90%' limit 1`)).rowCount) return;
  const incident = async (type: string, loc: string, days: number, outcome: string) =>
    (
      await c.query(
        `insert into incidents (reporter_id, type, location_id, geom, state, severity, agency_id, station_id, outcome_code, received_at, closed_at, created_at)
         select $1, $2, l.id, l.geom, 'resolved', 3, $3, $4, $5, $6, $6::timestamptz + interval '50 minutes', $6 from locations l where l.id = $7 returning id`,
        [ids.citizen, type, at.police, at.ikeja, outcome, ago(days), loc],
      )
    ).rows[0].id as string;
  const robbery = await incident('robbery', L.allen!, 6, 'arrest');
  const burglary = await incident('robbery', L.toyin!, 3, 'arrest');
  const violence = await incident('violence', L.opebi!, 1, 'arrest');
  const make = async (no: string, inc: string, who: string, role: string, state: string, note: string, extra: { original?: string; english?: string } = {}) =>
    (
      await c.query(
        `insert into statements (number, incident_id, citizen_id, station_id, agency_id, requested_by, request_note, role, state, draft_language, draft_original, draft_english, draft_confidence, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [no, inc, who, at.ikeja, at.police, ids.head, note, role, state, extra.original ? 'yo' : null, state === 'signed' ? null : (extra.original ?? null), state === 'signed' ? null : (extra.english ?? null), extra.original ? 0.93 : null, ago(5)],
      )
    ).rows[0].id as string;
  const signedOriginal = 'Mo n bọ lati ọja nigbati ọkunrin meji da mi duro ni Allen Avenue. Wọn gba foonu mi ati apo mi.';
  const signedEnglish = 'I was coming back from the market when two men stopped me on Allen Avenue. They took my phone and my bag. One had a knife.';
  const signed = await make('ST-900101', robbery, ids.citizen, 'victim', 'signed', 'Tell us what happened, in your own words.');
  const signedAt = ago(5).toISOString();
  const seal = createHash('sha256').update(JSON.stringify({ statementId: signed, version: 1, language: 'yo', original: signedOriginal, english: signedEnglish, signedAt })).digest('hex');
  await c.query(
    `insert into statement_versions (statement_id, version, language, original_text, english_text, ai_confidence, signed_with, seal, signed_at, role)
     values ($1, 1, 'yo', $2, $3, 0.93, 'pin', $4, $5, 'victim')`,
    [signed, signedOriginal, signedEnglish, seal, signedAt],
  );
  await c.query(`insert into statement_access (statement_id, actor_id, action, at) values ($1, $2, 'opened', $3), ($1, $4, 'downloaded', $3)`, [signed, ids.head, ago(4), ids.agencyAdmin]);
  await make('ST-900102', robbery, ids.neighbour, 'witness', 'requested', 'You were at the gate. What did you see?');
  await make('ST-900103', burglary, ids.citizen, 'complainant', 'draft', 'List what was taken, if you can.', {
    original: 'They broke the back window at night. My laptop and TV are gone.',
    english: 'They broke the back window at night. My laptop and TV are gone.',
  });
  const change = await make('ST-900104', violence, ids.citizen, 'complainant', 'change_requested', 'Describe the fight and who started it.');
  await c.query(`update statements set change_note = 'Please add the time it started and how many people were there.' where id = $1`, [change]);
}

// ---------------------------------------------------------------- equipment the agency is billed for
async function equipment(c: Queryable, ids: Ids, at: Places) {
  if ((await c.query(`select 1 from agency_inventory where agency_id = $1 limit 1`, [at.police])).rowCount) return;
  const rows: [string, string, number, string, string | null, string | null, number][] = [
    // fee, name, quantity, status, station, pilot, last checked (days ago)
    ['inventory_vehicle', 'Patrol 4-1 (Toyota Hilux)', 1, 'in_use', at.ikeja, null, 1],
    ['inventory_vehicle', 'Patrol 4-2 (Toyota Hilux)', 1, 'ready', at.ikeja, null, 2],
    ['inventory_vehicle', 'Patrol 2-1', 1, 'needs_service', at.yaba, null, 30],
    ['inventory_defence_drone', 'Defence drone 1', 1, 'ready', at.ikeja, 'Insp. Musa Bello', 3],
    ['inventory_fire_drone', 'Fire-fighter drone 1', 1, 'ready', at.ikeja, 'Sgt. Bola Ade', 5],
    ['inventory_body_cam', 'Body cams, Ikeja', 6, 'in_use', at.ikeja, null, 1],
    ['inventory_body_cam', 'Body cams, Yaba', 4, 'ready', at.yaba, null, 7],
    ['inventory_radio', 'Handheld radios', 12, 'ready', at.ikeja, null, 10],
    ['inventory_sensor', 'Alert sensors, Allen market', 3, 'ready', at.ikeja, null, 14],
    ['inventory_smart_pole', 'Smart street lights, Allen and Opebi', 2, 'in_use', at.ikeja, null, 2],
    ['inventory_camera', 'Dash cameras', 3, 'out_of_service', at.yaba, null, 45],
    ['inventory_other', 'First aid and trauma kits', 5, 'ready', at.ikeja, null, 20],
  ];
  for (const [fee, name, qty, status, station, pilot, checked] of rows) {
    await c.query(
      `insert into agency_inventory (agency_id, station_id, fee_code, quantity, added_by, name, status, pilot_name, last_check_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [at.police, station, fee, qty, ids.agencyAdmin, name, status, pilot, ago(checked), ago(60)],
    );
  }
}

// ---------------------------------------------------------------- infrastructure assets
async function assets(c: Queryable, ids: Ids, at: Places, L: Record<string, string>) {
  const rows: [string, string, string, string, string, string | null, number | null, number, number][] = [
    // agency, kind, name, location, status, fault, battery, next service (days from now), last signal (minutes ago)
    [at.ferma, 'traffic_light', 'Ikorodu Rd / Jibowu junction', L.ikorodu!, 'online', null, null, 40, 2],
    [at.ferma, 'traffic_light', 'Herbert Macaulay / Sabo junction', L.sabo!, 'fault', 'Red lamp out on the north arm', null, 12, 3],
    [at.ferma, 'traffic_light', 'Yaba roundabout', L.yaba!, 'offline', 'Controller not responding', null, -5, 900],
    [at.ferma, 'street_light', 'Ikorodu Rd, lights 1 to 12', L.ikorodu!, 'online', null, 92, 60, 5],
    [at.ferma, 'street_light', 'Sabo Market Rd, lights 1 to 6', L.sabo!, 'low_power', null, 19, 20, 8],
    [at.ferma, 'solar_panel', 'Jibowu solar array', L.ikorodu!, 'online', null, 88, 90, 10],
    [at.ferma, 'camera', 'Jibowu junction camera', L.ikorodu!, 'online', null, null, 30, 1],
    [at.ferma, 'other', 'Flood gauge, Sabo canal', L.sabo!, 'online', null, 70, 45, 15],
    [at.police, 'smart_pole', 'Allen Avenue smart pole', L.allen!, 'online', null, 96, 75, 1],
    [at.police, 'smart_pole', 'Opebi Road smart pole', L.opebi!, 'online', null, 81, 75, 1],
    [at.police, 'drone_house', 'Allen Avenue drone charging house', L.allen!, 'online', null, 100, 60, 1],
    [at.police, 'camera', 'Allen roundabout camera', L.allen!, 'fault', 'Picture blurred: lens moved', null, 3, 4],
    [at.police, 'camera', 'Toyin Street camera', L.toyin!, 'online', null, null, 50, 2],
    [at.police, 'sensor', 'Transformer sensor, Allen', L.allen!, 'low_power', null, 22, 8, 20],
    [at.police, 'sensor', 'Alarm and sensor, Opebi market', L.opebi!, 'online', null, 77, 30, 6],
    [at.police, 'street_light', 'Toyin Street lights', L.toyin!, 'online', null, 84, -2, 9],
  ];
  for (const [agency, kind, name, loc, status, fault, battery, next, signal] of rows) {
    const r = await c.query(
      `insert into agency_assets (agency_id, kind, name, location_id, status, fault_detail, last_signal_at, power, battery_pct, controller, installed_on, last_service_on, next_service_on, warranty_until)
       values ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7), $8, $9, $10, $11, $12, $13, $14)
       on conflict (agency_id, name) do nothing returning id`,
      [
        agency, kind, name, loc, status, fault, signal, battery === null ? 'Mains' : 'Solar', battery,
        kind === 'traffic_light' ? 'Siemens sX' : kind === 'smart_pole' ? 'SSS pole controller v2' : null,
        isoDay(ago(400)), isoDay(ago(80)), isoDay(new Date(Date.now() + next * DAY)), isoDay(new Date(Date.now() + 700 * DAY)),
      ],
    );
    const id = r.rows[0]?.id;
    if (!id) continue;
    if (fault) {
      await c.query(`insert into asset_faults (asset_id, what, opened_at) values ($1, $2, now() - interval '2 days')`, [id, fault]);
      await c.query(`insert into asset_work_orders (number, asset_id, kind, note, state, created_by, created_at) values ($1, $2, 'repair', $3, 'open', $4, now() - interval '1 day')`, [
        `WO-${Math.floor(100000 + Math.random() * 899999)}`, id, fault, agency === at.ferma ? ids.fermaAdmin : ids.agencyAdmin,
      ]);
    }
    await c.query(`insert into asset_faults (asset_id, what, opened_at, closed_at, fix) values ($1, 'Lost signal for an hour', now() - interval '40 days', now() - interval '39 days', 'Gateway restarted')`, [id]);
    await c.query(`insert into asset_work_orders (number, asset_id, kind, note, state, created_by, created_at, done_at) values ($1, $2, 'service', 'Routine service', 'done', $3, now() - interval '80 days', now() - interval '79 days')`, [
      `WO-${Math.floor(100000 + Math.random() * 899999)}`, id, agency === at.ferma ? ids.fermaAdmin : ids.agencyAdmin,
    ]);
  }
}

// ---------------------------------------------------------------- platform store stock: the product range
async function stock(c: Queryable) {
  const add: Record<string, Record<string, number>> = {
    'Ikeja store': { smart_pole: 6, defence_drone: 4, fire_drone: 3, body_cam: 40, sensor: 25, drone: 2, other: 15 },
    'Yaba store': { smart_pole: 2, defence_drone: 1, fire_drone: 1, body_cam: 12, sensor: 4, drone: 1, other: 6 },
  };
  for (const [store, items] of Object.entries(add)) {
    const st = (await c.query(`select id from stores where name = $1`, [store])).rows[0]?.id;
    if (!st) continue;
    for (const [item, q] of Object.entries(items)) {
      await c.query(`insert into store_stock (store_id, item, quantity, reorder_at) values ($1, $2, $3, $4) on conflict do nothing`, [st, item, q, item === 'body_cam' ? 15 : 3]);
    }
  }
}

// ---------------------------------------------------------------- invoices
const VAT = 0.075;
async function invoices(c: Queryable, ids: Ids, at: Places) {
  for (const [agency, base, extra] of [
    [at.police, 25000000, [['inventory_defence_drone', 'Defence drone', 1, 2500000], ['inventory_body_cam', 'Officer body cam', 10, 200000], ['inventory_vehicle', 'Vehicle tracker', 3, 500000], ['messaging_sms', 'SMS message', 1800, 400]]],
    [at.ferma, 25000000, [['inventory_other', 'Other equipment', 2, 100000], ['messaging_sms', 'SMS message', 600, 400]]],
  ] as const) {
    if ((await c.query(`select 1 from invoices where agency_id = $1 limit 1`, [agency])).rowCount) continue;
    const line = (code: string, label: string, quantity: number, unitKobo: number) => ({ code, label, quantity, unitKobo, amountKobo: quantity * unitKobo });
    const monthly = [line('agency_base', 'Base: dashboard and routing', 1, base), ...extra.map(([code, label, q, u]) => line(code, label, q, u))];
    const month = (back: number) => {
      const d = new Date();
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back + 1, 0));
      return { start: isoDay(start), end: isoDay(end), due: isoDay(new Date(start.getTime() + 14 * DAY)) };
    };
    const list: { kind: string; lines: ReturnType<typeof line>[]; state: string; m: ReturnType<typeof month>; po?: string; method?: 'paystack' | 'bank' }[] = [
      { kind: 'onboarding', lines: [line('onboarding', 'Onboarding and document check', 1, 50000000)], state: 'paid', m: month(4), method: 'bank' },
      { kind: 'monthly', lines: monthly, state: 'paid', m: month(3), method: 'paystack' },
      { kind: 'monthly', lines: monthly, state: 'paid', m: month(2), method: 'bank', po: 'PO-NPF-2026-0441' },
      { kind: 'monthly', lines: monthly, state: agency === at.police ? 'overdue' : 'paid', m: month(1), method: agency === at.police ? undefined : 'paystack' },
      { kind: 'monthly', lines: monthly, state: 'issued', m: month(0) },
    ];
    for (const inv of list) {
      const subtotal = inv.lines.reduce((s, l) => s + l.amountKobo, 0);
      const vat = Math.round(subtotal * VAT);
      const seq = (await c.query(`select nextval('invoice_number_seq') as n`)).rows[0].n;
      const paid = inv.state === 'paid' ? new Date(new Date(inv.m.due).getTime() - 3 * DAY) : null;
      const id = (
        await c.query(
          `insert into invoices (agency_id, number, kind, lines, subtotal_kobo, vat_kobo, total_kobo, due_on, period_start, period_end, state, po_number, paid_at, created_at, reminders_sent)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
          [
            agency, `INV-${inv.m.due.slice(0, 4)}-${String(seq).padStart(6, '0')}`, inv.kind, JSON.stringify(inv.lines), subtotal, vat, subtotal + vat, inv.m.due,
            inv.kind === 'monthly' ? inv.m.start : null, inv.kind === 'monthly' ? inv.m.end : null, inv.state, inv.po ?? null, paid, inv.m.start,
            inv.state === 'overdue' ? ['d-3', 'd-0'] : [],
          ],
        )
      ).rows[0].id;
      if (!paid) continue;
      if (inv.method === 'paystack') {
        const pay = (
          await c.query(
            `insert into payments (user_id, agency_id, purpose, purpose_ref, amount_kobo, method, provider_ref, idempotency_key, state)
             values ($1, $2, 'agency_invoice', $3, $4, 'card', $5, $5, 'succeeded') returning id`,
            [agency === at.police ? ids.agencyAdmin : ids.fermaAdmin, agency, id, subtotal + vat, `seed-inv-${id}`],
          )
        ).rows[0].id;
        await c.query(`insert into invoice_payments (invoice_id, amount_kobo, method, payment_id, received_on) values ($1, $2, 'paystack', $3, $4)`, [id, subtotal + vat, pay, isoDay(paid)]);
      } else {
        await c.query(`insert into invoice_payments (invoice_id, amount_kobo, method, bank_reference, received_on, marked_by, note) values ($1, $2, 'bank_transfer_marked', $3, $4, $5, 'Bank transfer received')`, [
          id, subtotal + vat, `TRF-${String(seq).padStart(6, '0')}`, isoDay(paid), ids.platformAdmin,
        ]);
      }
    }
  }
}

// ---------------------------------------------------------------- stolen-item registry
/** A one-page PDF that says "Receipt", so proof documents show as provided. */
const RECEIPT_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj ' +
    '4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 40 100 Td (Demo receipt) Tj ET\nendstream endobj ' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function stolenItems(c: Queryable, ids: Ids, at: Places, L: Record<string, string>) {
  if ((await c.query(`select 1 from stolen_cases where public_no like 'S-90%' limit 1`)).rowCount) return;
  const item = async (owner: string, type: string, identifier: string, make: string, model: string, colour: string, days: number, registered = true) =>
    (
      await c.query(`insert into owned_items (owner_id, type_code, identifier, make, model, colour, registered, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, [
        owner, type, identifier, make, model, colour, registered, ago(days),
      ])
    ).rows[0].id as string;
  const receipt = async (ownerType: 'owned_item' | 'stolen_case', ownerId: string, uploader: string, doc: string) => {
    const key = `${ownerType}/${ownerId}/demo-${doc}`;
    await c.query(
      `insert into media (owner_type, owner_id, uploader_id, kind, content_type, size_bytes, storage_key, state, doc_code, sha256) values ($1, $2, $3, 'document', 'application/pdf', $4, $5, 'ready', $6, $7)`,
      [ownerType, ownerId, uploader, RECEIPT_PDF.length, key, doc, createHash('sha256').update(RECEIPT_PDF).digest('hex')],
    );
    await c.query(`insert into media_blobs (storage_key, bytes) values ($1, $2)`, [key, RECEIPT_PDF]);
  };
  const kase = async (no: string, itemId: string, owner: string, type: string, identifier: string, loc: string, days: number, state: string, text: string, reportNo: string | null) =>
    (
      await c.query(
        `insert into stolen_cases (public_no, item_id, reporter_id, type_code, identifier, state, stolen_on, circumstances, police_report_no, location_id, geom, agency_id, agency_label, station_id, client_ref, created_at, updated_at, closed_at)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, l.id, l.geom, $10, 'Nigeria Police Force (demo)', $11, $12, $13, $13, $14 from locations l where l.id = $15 returning id`,
        [no, itemId, owner, type, identifier, state, isoDay(ago(days)), text, reportNo, at.police, at.ikeja, `demo-${no}`, ago(days), state === 'returned' ? ago(days - 8) : null, loc],
      )
    ).rows[0].id as string;
  const event = (caseId: string, kind: string, actor: string, actorId: string | null, days: number, to: string | null, payload: Record<string, unknown> = {}) =>
    c.query(`insert into stolen_case_events (case_id, kind, actor_kind, actor_id, to_state, payload, at) values ($1, $2, $3, $4, $5, $6, $7)`, [caseId, kind, actor, actorId, to, payload, ago(days)]);
  const check = async (no: string, checker: string, type: string, identifier: string, caseId: string | null, loc: string, days: number, context = 'buying') =>
    (
      await c.query(
        `insert into item_checks (check_no, checker_id, type_code, identifier, result, case_id, context, location_id, geom, accuracy_m, agency_id, station_id, at)
         select $1, $2, $3, $4, $5, $6, $7, l.id, l.geom, 15, $8, $9, $10 from locations l where l.id = $11 returning id`,
        [no, checker, type, identifier, caseId ? 'stolen' : 'clean', caseId, context, at.police, at.ikeja, ago(days), loc],
      )
    ).rows[0].id as string;

  // Ada's phone: registered with a receipt, stolen on Allen Avenue, then offered for sale at Sabo market.
  const phone = await item(ids.citizen, 'phone', '356938035643809', 'Tecno', 'Camon 20', 'Black', 40);
  await receipt('owned_item', phone, ids.citizen, 'receipt');
  const k1 = await kase('S-900101', phone, ids.citizen, 'phone', '356938035643809', L.allen!, 3, 'reported', 'Snatched from my hand by two men on a motorbike near the bus stop, around 7 pm.', null);
  await event(k1, 'reported', 'owner', ids.citizen, 3, 'reported');
  const m1 = await check('C-900101', ids.neighbour, 'phone', '356938035643809', k1, L.sabo!, 1);
  await event(k1, 'match', 'checker', ids.neighbour, 1, null, { checkId: m1, context: 'buying' });
  await event(k1, 'match_detail', 'checker', ids.neighbour, 0.95, null, { checkId: m1, sellerName: 'Young man called Tunde', sellerPhone: '0803 555 0199', note: 'Selling it for ₦45,000 at a stall by the Sabo market gate.' });

  // Ada's laptop: registered, never stolen. Checks of its serial come back clean.
  const laptop = await item(ids.citizen, 'laptop', '5CG1234XYZ', 'HP', 'EliteBook 840', 'Silver', 25);
  await receipt('owned_item', laptop, ids.citizen, 'receipt');

  // The neighbour's car: stolen in Yaba, under investigation; a buyer check near Ikorodu Road was followed up.
  const car = await item(ids.neighbour, 'car', '2T1BU4EE9CC123456', 'Toyota', 'Corolla 2012', 'Grey', 200);
  await receipt('owned_item', car, ids.neighbour, 'ownership');
  const k2 = await kase('S-900102', car, ids.neighbour, 'car', '2T1BU4EE9CC123456', L.yaba!, 10, 'investigating', 'Taken from outside my house overnight. The gate lock was cut.', 'LA/YAB/2026/1182');
  await event(k2, 'reported', 'owner', ids.neighbour, 10, 'reported');
  await event(k2, 'investigate', 'agency', ids.agencyAdmin, 9, 'investigating', { note: 'Plate circulated to all Lagos divisions.' });
  const m2 = await check('C-900102', ids.citizen, 'car', '2T1BU4EE9CC123456', k2, L.ikorodu!, 2);
  await event(k2, 'match', 'checker', ids.citizen, 2, null, { checkId: m2, context: 'buying' });
  await event(k2, 'match_reviewed', 'agency', ids.agencyAdmin, 1.5, null, { checkId: m2, outcome: 'followed_up', note: 'Team visited the car lot on Ikorodu Road. Seller fled; lot owner questioned.', agencyId: at.police });

  // The neighbour's old phone: stolen, recovered and returned.
  const old = await item(ids.neighbour, 'phone', '352099001761481', 'Samsung', 'Galaxy A54', 'Blue', 90);
  const k3 = await kase('S-900103', old, ids.neighbour, 'phone', '352099001761481', L.opebi!, 30, 'returned', 'Left in a taxi on Opebi Road.', null);
  await event(k3, 'reported', 'owner', ids.neighbour, 30, 'reported');
  await event(k3, 'locate', 'agency', ids.agencyAdmin, 26, 'located', { note: 'Phone switched on in Ikeja; repair shop identified.' });
  await event(k3, 'recover', 'agency', ids.agencyAdmin, 25, 'recovered', { note: 'Recovered from a repair shop on Toyin Street.' });
  await event(k3, 'return_to_owner', 'agency', ids.agencyAdmin, 22, 'returned', { note: 'Owner collected it at Ikeja station with the receipt.' });

  // A clean check: someone about to buy a phone that was never reported.
  await check('C-900103', ids.citizen, 'phone', '867531042211876', null, L.toyin!, 5);
}
