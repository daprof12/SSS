// Stolen-item registry: item types (platform admins), my items (owners), stolen reports, buyer
// checks ("check before you buy") and the police queue that takes both to recovery.
import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  applyEvent,
  availableEvents,
  checkRule,
  CHECKS_PER_HOUR,
  STOLEN_AGENCY_KINDS,
  STOLEN_OPEN,
  STOLEN_STEPS,
  stolenMachine,
  stolenStateLabel,
  stolenStatus,
  validateIdentifier,
  type CheckContext,
  type IdentifierRule,
  type ItemDocument,
  type ItemTypeDef,
  type StolenEvent,
  type StolenState,
} from '@erp/domain';
import { POSTCODE, PostcodeUnavailable, type Building, type PostcodeAdapter } from '../adapters/postcode';
import { AgencyLifecycle } from '../agencies/agency.lifecycle';
import { Audit } from '../core/audit';
import type { Principal } from '../core/auth';
import { dateWhere, type DateRange } from '../core/date-range';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { locationWhere, type LocationFilter } from '../core/location-filter';
import { agencyStaff, notify, receivingAgency } from '../reports/shared';

export interface Where {
  postcode?: string;
  lat?: number;
  lng?: number;
}
export interface TypeBody {
  label: string;
  icon: string;
  identifierLabel: string;
  identifierHint: string;
  rule: IdentifierRule;
  documents: ItemDocument[];
  active: boolean;
  sort: number;
}
export interface ItemBody {
  typeCode: string;
  identifier: string;
  make?: string;
  model?: string;
  colour?: string;
  description?: string;
}
export interface StolenBody extends Where {
  itemId?: string;
  item?: ItemBody;
  stolenOn: string;
  circumstances?: string;
  policeReportNo?: string;
  clientRef: string;
}

const OPEN = STOLEN_OPEN as string[];
const lagosToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const field = (f: string, message: string, code = 'validation_failed', status = 422) => new AppError(status, code, message, { fields: [{ field: f, message }] });
const itemName = (r: { make?: string | null; model?: string | null; type_label: string }) => [r.make, r.model].filter(Boolean).join(' ') || r.type_label;

/** What the owner sees for each event in the case log. */
const OWNER_LABEL: Record<string, string> = {
  reported: 'Reported stolen',
  investigate: 'Police started investigating',
  locate: 'Police located the item',
  recover: 'Police recovered the item',
  return_to_owner: 'Returned to you',
  close: 'Police closed the case',
  withdraw: 'You withdrew the report',
  match: 'Someone checked it before buying',
};
const POLICE_LABEL: Record<string, string> = {
  reported: 'Reported stolen by the owner',
  investigate: 'Investigation started',
  locate: 'Item located',
  recover: 'Item recovered',
  return_to_owner: 'Returned to the owner',
  close: 'Closed without recovery',
  withdraw: 'Owner withdrew the report',
  match: 'Buyer check matched',
  match_detail: 'Buyer added details',
  match_reviewed: 'Match reviewed',
  note: 'Note',
};

@Injectable()
export class ItemsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(AgencyLifecycle) private readonly agencies: AgencyLifecycle,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
  ) {}

  // ---------------------------------------------------------------- item types

  private rowToType(r: any): ItemTypeDef & { active: boolean; sort: number } {
    return { code: r.code, label: r.label, icon: r.icon, identifierLabel: r.identifier_label, identifierHint: r.identifier_hint, rule: r.rule, documents: r.documents, active: r.active, sort: r.sort };
  }

  private async type(code: string, c: Queryable = this.db.pool) {
    const r = (await c.query(`select * from item_types where code = $1`, [code])).rows[0];
    return r ? this.rowToType(r) : null;
  }

  /** Types citizens can register, report and check. */
  async types() {
    const r = await this.db.query(`select * from item_types where active order by sort, label`);
    return r.rows.map((x) => {
      const { active: _a, sort: _s, ...t } = this.rowToType(x);
      return t;
    });
  }

  async adminTypes(p: Principal) {
    this.agencies.requirePlatformAdmin(p);
    const r = await this.db.query(
      `select t.*, (select count(*)::int from owned_items i where i.type_code = t.code and i.removed_at is null and i.registered) as items,
              (select count(*)::int from stolen_cases k where k.type_code = t.code and k.state = any($1::text[])) as open_cases
         from item_types t order by t.sort, t.label`,
      [OPEN],
    );
    return r.rows.map((x) => ({ ...this.rowToType(x), items: x.items, openCases: x.open_cases, updatedAt: x.updated_at }));
  }

  private checkTypeBody(b: TypeBody) {
    const bad = checkRule(b.rule);
    if (bad) throw field('rule', bad);
    const codes = b.documents.map((d) => d.code);
    if (new Set(codes).size !== codes.length) throw field('documents', 'Each document needs its own code.');
  }

  async createType(p: Principal, b: TypeBody & { code: string }) {
    this.agencies.requirePlatformAdmin(p);
    this.checkTypeBody(b);
    if (await this.type(b.code)) throw field('code', 'An item type with this code already exists.', 'code_taken', 409);
    await this.db.query(
      `insert into item_types (code, label, icon, identifier_label, identifier_hint, rule, documents, active, sort, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [b.code, b.label, b.icon, b.identifierLabel, b.identifierHint, JSON.stringify(b.rule), JSON.stringify(b.documents), b.active, b.sort, p.userId],
    );
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'item_type.created', entity: 'item_type', entityId: b.code, payload: { label: b.label } });
    return this.type(b.code);
  }

  async updateType(p: Principal, code: string, b: TypeBody) {
    this.agencies.requirePlatformAdmin(p);
    this.checkTypeBody(b);
    const r = await this.db.query(
      `update item_types set label = $2, icon = $3, identifier_label = $4, identifier_hint = $5, rule = $6, documents = $7, active = $8, sort = $9, updated_at = now() where code = $1`,
      [code, b.label, b.icon, b.identifierLabel, b.identifierHint, JSON.stringify(b.rule), JSON.stringify(b.documents), b.active, b.sort],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Item type not found.');
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'item_type.updated', entity: 'item_type', entityId: code, payload: { active: b.active } });
    return this.type(code);
  }

  /** A type a citizen may use now, and their identifier cleaned and checked against it. */
  private async identify(typeCode: string, identifier: string, c: Queryable = this.db.pool) {
    const t = await this.type(typeCode, c);
    if (!t || !t.active) throw field('typeCode', 'Choose what kind of item it is.');
    const v = validateIdentifier(t, identifier);
    if (!v.ok) throw field('identifier', v.message);
    return { t, identifier: v.value };
  }

  // ---------------------------------------------------------------- places

  /** Building and point for a place. GPS alone is fine when the address service is down. */
  private async resolve(w: Where, required: boolean): Promise<{ building: Building | null; lat: number | null; lng: number | null }> {
    let building: Building | null = null;
    try {
      building = w.postcode ? await this.postcode.lookup(w.postcode) : w.lat != null && w.lng != null ? await this.postcode.nearest(w.lat, w.lng, 100) : null;
    } catch (e) {
      if (!(e instanceof PostcodeUnavailable)) throw e;
    }
    if (w.postcode && !building) throw field('where', 'We could not find that place. Check the postcode or use where you are.', 'postcode_not_found');
    const lat = building?.lat ?? w.lat ?? null;
    const lng = building?.lng ?? w.lng ?? null;
    if (required && (lat == null || lng == null)) throw field('where', 'Add where it was stolen: your location or a postcode.', 'location_required');
    return { building, lat, lng };
  }

  private async saveLocation(c: Queryable, b: Building | null): Promise<string | null> {
    if (!b) return null;
    return (
      await c.query(
        `insert into locations (postcode, address_text, state_id, lga_id, district_id, area_id, area_label, geom)
         values ($1, $2, $3, $4, $5, $6, $7, st_setsrid(st_makepoint($9, $8), 4326)::geography)
         on conflict (postcode) do update set fetched_at = now() returning id`,
        [b.postcode, b.address, b.stateId, b.lgaId, b.districtId, b.areaId, b.areaLabel, b.lat, b.lng],
      )
    ).rows[0].id;
  }

  private async number(c: Queryable, table: 'stolen_cases' | 'item_checks', column: 'public_no' | 'check_no', prefix: string) {
    for (;;) {
      const no = `${prefix}-${String(randomInt(100000, 1000000))}`;
      if (!(await c.query(`select 1 from ${table} where ${column} = $1`, [no])).rowCount) return no;
    }
  }

  // ---------------------------------------------------------------- my items

  /** Required and optional proof for an item, and which are in. */
  private async documents(itemId: string, caseId: string | null, docs: ItemDocument[]) {
    const r = await this.db.query(
      `select doc_code, count(*)::int as n from media where state = 'ready' and doc_code is not null
          and ((owner_type = 'owned_item' and owner_id = $1) or (owner_type = 'stolen_case' and owner_id = $2)) group by doc_code`,
      [itemId, caseId],
    );
    const have = new Map(r.rows.map((x) => [x.doc_code, x.n]));
    const list = docs.map((d) => ({ ...d, provided: (have.get(d.code) ?? 0) > 0 }));
    return { documents: list, proofComplete: list.every((d) => !d.required || d.provided) };
  }

  async register(p: Principal, b: ItemBody) {
    const { t, identifier } = await this.identify(b.typeCode, b.identifier);
    const mine = (await this.db.query(`select id, registered from owned_items where owner_id = $1 and type_code = $2 and identifier = $3 and removed_at is null`, [p.userId, t.code, identifier])).rows[0];
    if (mine?.registered) throw new AppError(409, 'already_registered', `You already registered this ${t.label.toLowerCase()}.`, { itemId: mine.id });
    const other = await this.db.query(`select 1 from owned_items where owner_id <> $1 and type_code = $2 and identifier = $3 and removed_at is null and registered`, [p.userId, t.code, identifier]);
    if (other.rowCount) {
      throw new AppError(409, 'registered_elsewhere', `This ${t.identifierLabel} is registered to someone else. If the item is yours, report it stolen with your receipt and the police will check.`, {
        fields: [{ field: 'identifier', message: `This ${t.identifierLabel} is registered to someone else.` }],
      });
    }
    const id = mine
      ? (await this.db.query(`update owned_items set registered = true, make = coalesce($2, make), model = coalesce($3, model), colour = coalesce($4, colour), description = coalesce($5, description), updated_at = now() where id = $1 returning id`, [mine.id, b.make || null, b.model || null, b.colour || null, b.description || null])).rows[0].id
      : (
          await this.db.query(`insert into owned_items (owner_id, type_code, identifier, make, model, colour, description) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [
            p.userId,
            t.code,
            identifier,
            b.make || null,
            b.model || null,
            b.colour || null,
            b.description || null,
          ])
        ).rows[0].id;
    await this.audit.write({ actorId: p.userId, action: 'item.registered', entity: 'owned_item', entityId: id, payload: { type: t.code } });
    return this.item(p, id);
  }

  async mine(p: Principal) {
    const r = await this.db.query(
      `select i.*, t.label as type_label, t.icon, t.identifier_label, t.documents as type_docs, k.id as case_id, k.state as case_state, k.public_no
         from owned_items i join item_types t on t.code = i.type_code
         left join lateral (select id, state, public_no from stolen_cases where item_id = i.id order by created_at desc limit 1) k on true
        where i.owner_id = $1 and i.removed_at is null and (i.registered or k.id is not null)
        order by k.state = any($2::text[]) desc nulls last, i.created_at desc`,
      [p.userId, OPEN],
    );
    const out = [];
    for (const i of r.rows) {
      const docs = await this.documents(i.id, i.case_id, i.type_docs);
      out.push({
        id: i.id,
        type: i.type_code,
        typeLabel: i.type_label,
        icon: i.icon,
        name: itemName(i),
        identifierLabel: i.identifier_label,
        identifier: i.identifier,
        registered: i.registered,
        proofComplete: docs.proofComplete,
        stolen: i.case_id && OPEN.includes(i.case_state) ? { caseId: i.case_id, publicNo: i.public_no, state: i.case_state, status: stolenStatus(i.case_state, 'the police') } : null,
        lastCase: i.case_id ? { id: i.case_id, publicNo: i.public_no, state: i.case_state, label: stolenStateLabel[i.case_state as StolenState] } : null,
      });
    }
    return out;
  }

  async item(p: Principal, id: string) {
    const i = (
      await this.db.query(`select i.*, t.label as type_label, t.icon, t.identifier_label, t.documents as type_docs from owned_items i join item_types t on t.code = i.type_code where i.id = $1 and i.owner_id = $2 and i.removed_at is null`, [
        id,
        p.userId,
      ])
    ).rows[0];
    if (!i) throw new AppError(404, 'not_found', 'Item not found.');
    const cases = (await this.db.query(`select id, public_no, state, stolen_on, created_at from stolen_cases where item_id = $1 order by created_at desc`, [id])).rows;
    const open = cases.find((k) => OPEN.includes(k.state));
    const docs = await this.documents(id, open?.id ?? null, i.type_docs);
    return {
      id,
      type: i.type_code,
      typeLabel: i.type_label,
      icon: i.icon,
      name: itemName(i),
      make: i.make,
      model: i.model,
      colour: i.colour,
      description: i.description,
      identifierLabel: i.identifier_label,
      identifier: i.identifier,
      registered: i.registered,
      registeredAt: i.created_at,
      ...docs,
      openCase: open ? { id: open.id, publicNo: open.public_no, state: open.state, status: stolenStatus(open.state, 'the police') } : null,
      cases: cases.map((k) => ({ id: k.id, publicNo: k.public_no, state: k.state, label: stolenStateLabel[k.state as StolenState], stolenOn: k.stolen_on, createdAt: k.created_at })),
      canReport: !open,
      canRemove: !open,
    };
  }

  async remove(p: Principal, id: string) {
    const i = (await this.db.query(`select id from owned_items where id = $1 and owner_id = $2 and removed_at is null`, [id, p.userId])).rows[0];
    if (!i) throw new AppError(404, 'not_found', 'Item not found.');
    const open = await this.db.query(`select 1 from stolen_cases where item_id = $1 and state = any($2::text[])`, [id, OPEN]);
    if (open.rowCount) throw new AppError(409, 'stolen_open', 'This item is reported stolen. Withdraw the report first if you have it back.');
    await this.db.query(`update owned_items set removed_at = now(), updated_at = now() where id = $1`, [id]);
    await this.audit.write({ actorId: p.userId, action: 'item.removed', entity: 'owned_item', entityId: id });
    return { removed: true };
  }

  // ---------------------------------------------------------------- stolen reports (owner)

  async reportStolen(p: Principal, b: StolenBody) {
    const prior = (await this.db.query(`select id from stolen_cases where reporter_id = $1 and client_ref = $2`, [p.userId, b.clientRef])).rows[0];
    if (prior) return { ...(await this.caseSummary(prior.id)), duplicate: true };
    if (!b.itemId && !b.item) throw field('itemId', 'Choose the item that was stolen.');
    if (b.stolenOn > lagosToday()) throw field('stolenOn', 'The date cannot be in the future.');
    const { building, lat, lng } = await this.resolve(b, true);

    const out = await this.db.tx(async (c) => {
      let item: { id: string; type_code: string; identifier: string; make: string | null; model: string | null };
      if (b.itemId) {
        item = (await c.query(`select id, type_code, identifier, make, model from owned_items where id = $1 and owner_id = $2 and removed_at is null for update`, [b.itemId, p.userId])).rows[0];
        if (!item) throw new AppError(404, 'not_found', 'Item not found.');
      } else {
        const { t, identifier } = await this.identify(b.item!.typeCode, b.item!.identifier, c);
        const found = (await c.query(`select id, type_code, identifier, make, model from owned_items where owner_id = $1 and type_code = $2 and identifier = $3 and removed_at is null for update`, [p.userId, t.code, identifier])).rows[0];
        // An item never registered is added to the registry (not to "My items") so checks can find it.
        item =
          found ??
          (
            await c.query(
              `insert into owned_items (owner_id, type_code, identifier, make, model, colour, description, registered) values ($1, $2, $3, $4, $5, $6, $7, false) returning id, type_code, identifier, make, model`,
              [p.userId, t.code, identifier, b.item!.make || null, b.item!.model || null, b.item!.colour || null, b.item!.description || null],
            )
          ).rows[0];
      }
      const open = (await c.query(`select id, public_no from stolen_cases where item_id = $1 and state = any($2::text[])`, [item.id, OPEN])).rows[0];
      if (open) throw new AppError(409, 'already_reported', `You already reported this item stolen (${open.public_no}).`, { caseId: open.id });
      const conflict = (await c.query(`select 1 from owned_items where owner_id <> $1 and type_code = $2 and identifier = $3 and removed_at is null and registered`, [p.userId, item.type_code, item.identifier])).rowCount;
      const locationId = await this.saveLocation(c, building);
      const agency = await receivingAgency(c, STOLEN_AGENCY_KINDS, { locationId, lat, lng });
      const no = await this.number(c, 'stolen_cases', 'public_no', 'S');
      const k = (
        await c.query(
          `insert into stolen_cases (public_no, item_id, reporter_id, type_code, identifier, stolen_on, circumstances, police_report_no, location_id, geom, agency_id, agency_label, station_id, ownership_conflict, client_ref)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, st_setsrid(st_makepoint($11, $10), 4326)::geography, $12, $13, $14, $15, $16) returning id`,
          [no, item.id, p.userId, item.type_code, item.identifier, b.stolenOn, b.circumstances?.trim() || null, b.policeReportNo?.trim() || null, locationId, lat, lng, agency?.id ?? null, agency?.name ?? 'Nigeria Police Force', agency?.stationId ?? null, !!conflict, b.clientRef],
        )
      ).rows[0];
      await c.query(`insert into stolen_case_events (case_id, kind, actor_kind, actor_id, to_state) values ($1, 'reported', 'owner', $2, 'reported')`, [k.id, p.userId]);
      if (agency) {
        const t = (await c.query(`select label from item_types where code = $1`, [item.type_code])).rows[0];
        await notify(c, await agencyStaff(c, agency.id), {
          type: 'stolen_new',
          grp: 'reports',
          title: 'Stolen item reported',
          body: `${[item.make, item.model].filter(Boolean).join(' ') || t.label}${building ? ` near ${building.areaLabel}` : ''}.${conflict ? ' Also registered to someone else.' : ''}`,
          link: `/agency/stolen/${k.id}`,
        });
      }
      return k.id as string;
    });
    await this.audit.write({ actorId: p.userId, action: 'stolen.reported', entity: 'stolen_case', entityId: out });
    return this.caseSummary(out);
  }

  private async caseSummary(id: string) {
    const k = (await this.db.query(`select id, public_no, agency_label, item_id, state from stolen_cases where id = $1`, [id])).rows[0];
    return { id: k.id, publicNo: k.public_no, routedTo: k.agency_label, itemId: k.item_id, state: k.state };
  }

  async myCases(p: Principal) {
    const r = await this.db.query(
      `select k.id, k.public_no, k.state, k.agency_label, k.created_at, i.make, i.model, t.label as type_label,
              (select count(*)::int from item_checks ch where ch.case_id = k.id and ch.checker_id <> k.reporter_id) as matches
         from stolen_cases k join owned_items i on i.id = k.item_id join item_types t on t.code = k.type_code
        where k.reporter_id = $1 order by k.state = any($2::text[]) desc, k.created_at desc`,
      [p.userId, OPEN],
    );
    return r.rows.map((k) => ({ id: k.id, publicNo: k.public_no, name: itemName(k), state: k.state, status: stolenStatus(k.state, k.agency_label), matches: k.matches, createdAt: k.created_at }));
  }

  /** The owner's view: recovery steps, what the police did, and that someone checked it (never who). */
  async caseDetail(p: Principal, id: string) {
    const k = (
      await this.db.query(
        `select k.*, i.make, i.model, i.colour, t.label as type_label, t.identifier_label, t.documents as type_docs, l.postcode, l.address_text, l.area_label
           from stolen_cases k join owned_items i on i.id = k.item_id join item_types t on t.code = k.type_code left join locations l on l.id = k.location_id
          where k.id = $1 and k.reporter_id = $2`,
        [id, p.userId],
      )
    ).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Report not found.');
    const events = (await this.db.query(`select kind, to_state, payload, at from stolen_case_events where case_id = $1 and kind = any($2::text[]) order by id`, [id, Object.keys(OWNER_LABEL)])).rows;
    const matches = (
      await this.db.query(
        `select ch.at, l.area_label from item_checks ch left join locations l on l.id = ch.location_id where ch.case_id = $1 and ch.checker_id <> $2 order by ch.at desc`,
        [id, p.userId],
      )
    ).rows;
    const reached = new Map<string, string>();
    for (const e of events) if (e.to_state && !reached.has(e.to_state)) reached.set(e.to_state, e.at);
    const state = k.state as StolenState;
    const ended = ['closed', 'withdrawn'].includes(state);
    const docs = await this.documents(k.item_id, id, k.type_docs);
    return {
      id,
      publicNo: k.public_no,
      itemId: k.item_id,
      name: itemName(k),
      typeLabel: k.type_label,
      identifierLabel: k.identifier_label,
      identifier: k.identifier,
      colour: k.colour,
      agency: k.agency_label,
      state,
      status: stolenStatus(state, k.agency_label),
      stolenOn: k.stolen_on,
      circumstances: k.circumstances,
      policeReportNo: k.police_report_no,
      place: k.postcode ? `${k.address_text}, ${k.postcode}` : 'Location from GPS',
      steps: ended
        ? []
        : STOLEN_STEPS.map((s) => ({ key: s.key, label: s.label, done: reached.has(s.key), at: reached.get(s.key) ?? null })),
      matches: { count: matches.length, last: matches[0] ? { at: matches[0].at, area: matches[0].area_label ?? null } : null },
      timeline: events.map((e) => ({ label: OWNER_LABEL[e.kind] ?? e.kind, note: e.kind === 'match' ? null : (e.payload?.note ?? null), at: e.at })),
      ...docs,
      canWithdraw: availableEvents(stolenMachine, state, 'owner').includes('withdraw'),
      canAddFiles: OPEN.includes(state),
      createdAt: k.created_at,
    };
  }

  private async transition(c: Queryable, caseId: string, event: StolenEvent, actor: 'agency_admin' | 'owner', actorId: string, payload: Record<string, unknown>) {
    const k = (await c.query(`select state from stolen_cases where id = $1 for update`, [caseId])).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Report not found.');
    const r = applyEvent(stolenMachine, k.state as StolenState, event, actor);
    if (!r.ok) throw new AppError(r.code === 'actor_not_allowed' ? 403 : 409, r.code, 'That is not possible at this stage.');
    const ends = ['returned', 'closed', 'withdrawn'].includes(r.to);
    await c.query(`update stolen_cases set state = $2, updated_at = now()${ends ? ', closed_at = now()' : ''} where id = $1`, [caseId, r.to]);
    await c.query(`insert into stolen_case_events (case_id, kind, actor_kind, actor_id, from_state, to_state, payload) values ($1, $2, $3, $4, $5, $6, $7)`, [
      caseId,
      event,
      actor === 'owner' ? 'owner' : 'agency',
      actorId,
      k.state,
      r.to,
      payload,
    ]);
    return r.to;
  }

  /** The owner has it back, or reported by mistake. The item then checks clean again. */
  async withdraw(p: Principal, id: string, reason: 'found' | 'mistake') {
    return this.db.tx(async (c) => {
      const k = (await c.query(`select agency_id, public_no from stolen_cases where id = $1 and reporter_id = $2`, [id, p.userId])).rows[0];
      if (!k) throw new AppError(404, 'not_found', 'Report not found.');
      const to = await this.transition(c, id, 'withdraw', 'owner', p.userId, { reason });
      if (k.agency_id) {
        await notify(c, await agencyStaff(c, k.agency_id), { type: 'stolen_withdrawn', grp: 'reports', title: 'Stolen report withdrawn', body: `${k.public_no}: ${reason === 'found' ? 'the owner has the item back' : 'reported by mistake'}.`, link: `/agency/stolen/${id}` });
      }
      await this.audit.write({ actorId: p.userId, action: 'stolen.withdrawn', entity: 'stolen_case', entityId: id, payload: { reason } }, c);
      return { state: to };
    });
  }

  // ---------------------------------------------------------------- check before you buy

  async check(p: Principal, b: Where & { typeCode: string; identifier: string; context: CheckContext; accuracy?: number }, meta: { ip?: string; userAgent?: string }) {
    const recent = (await this.db.query(`select count(*)::int as n from item_checks where checker_id = $1 and at > now() - interval '1 hour'`, [p.userId])).rows[0].n;
    if (recent >= CHECKS_PER_HOUR) throw new AppError(429, 'too_many_checks', 'You have made many checks in the last hour. Try again later.');
    const { t, identifier } = await this.identify(b.typeCode, b.identifier);
    // Where the check was made goes to the police with a match; a check never fails for want of it.
    const { building, lat, lng } = await this.resolve(b, false).catch((e) => {
      if (e instanceof AppError) return { building: null, lat: b.lat ?? null, lng: b.lng ?? null };
      throw e;
    });

    const out = await this.db.tx(async (c) => {
      const k = (
        await c.query(
          `select k.id, k.reporter_id, k.agency_id, k.public_no, i.make, i.model, i.colour from stolen_cases k join owned_items i on i.id = k.item_id
            where k.type_code = $1 and k.identifier = $2 and k.state = any($3::text[]) order by k.created_at limit 1`,
          [t.code, identifier, OPEN],
        )
      ).rows[0];
      const locationId = await this.saveLocation(c, building);
      const local = lat != null && lng != null ? await receivingAgency(c, STOLEN_AGENCY_KINDS, { locationId, lat, lng }) : null;
      const no = await this.number(c, 'item_checks', 'check_no', 'C');
      const ch = (
        await c.query(
          `insert into item_checks (check_no, checker_id, type_code, identifier, result, case_id, context, location_id, geom, accuracy_m, agency_id, station_id, ip, user_agent)
           values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9::float8 is null then null else st_setsrid(st_makepoint($10, $9), 4326)::geography end, $11, $12, $13, $14, $15) returning id, at`,
          [no, p.userId, t.code, identifier, k ? 'stolen' : 'clean', k?.id ?? null, b.context, locationId, lat, lng, b.accuracy ?? null, local?.id ?? null, local?.stationId ?? null, meta.ip ?? null, meta.userAgent?.slice(0, 200) ?? null],
        )
      ).rows[0];
      const own = !!k && k.reporter_id === p.userId;
      if (k && !own) {
        await c.query(`insert into stolen_case_events (case_id, kind, actor_kind, actor_id, payload) values ($1, 'match', 'checker', $2, $3)`, [k.id, p.userId, { checkId: ch.id, context: b.context }]);
        const name = [k.make, k.model].filter(Boolean).join(' ') || t.label;
        const where = building ? ` near ${building.areaLabel}` : '';
        // The police on the case, and the police where the check was made if that is another agency.
        const police = new Set<string>([...(k.agency_id ? await agencyStaff(c, k.agency_id) : []), ...(local && local.id !== k.agency_id ? await agencyStaff(c, local.id) : [])]);
        await notify(c, [...police], { type: 'stolen_match', grp: 'reports', title: 'Stolen item checked', body: `Someone checked the stolen ${name} (${k.public_no})${where}.`, link: `/agency/stolen/${k.id}` });
        await notify(c, [k.reporter_id], {
          type: 'stolen_match',
          grp: 'reports',
          title: 'Someone checked your stolen item',
          body: `Your ${name.toLowerCase()} was checked${where} before a sale. The police have the details.`,
          link: `/stolen/${k.id}`,
        });
      }
      return { id: ch.id as string, checkNo: no, at: ch.at, case: k, own };
    });
    await this.audit.write({ actorId: p.userId, action: out.case ? 'item_check.match' : 'item_check.clean', entity: 'item_check', entityId: out.id, payload: { type: t.code } });
    const item = out.case ? [out.case.make, out.case.model].filter(Boolean).join(' ') || t.label : null;
    return {
      id: out.id,
      checkNo: out.checkNo,
      at: out.at,
      typeLabel: t.label,
      identifierLabel: t.identifierLabel,
      identifier,
      result: out.case ? ('stolen' as const) : ('clean' as const),
      stolen: out.case ? { item, colour: out.case.colour ?? null, publicNo: out.case.public_no, yours: out.own } : null,
    };
  }

  /** After a match the buyer can tell the police who is selling it. Their own words; never required. */
  async checkDetails(p: Principal, checkId: string, b: { sellerName?: string; sellerPhone?: string; note?: string }) {
    const ch = (await this.db.query(`select id, case_id, agency_id, at from item_checks where id = $1 and checker_id = $2`, [checkId, p.userId])).rows[0];
    if (!ch) throw new AppError(404, 'not_found', 'Check not found.');
    if (!ch.case_id) throw new AppError(409, 'not_a_match', 'This item was not reported stolen.');
    if (Date.now() - +new Date(ch.at) > 7 * 86_400_000) throw new AppError(409, 'too_late', 'Details can be added for 7 days after a check. Contact the police directly.');
    const payload = { checkId, sellerName: b.sellerName?.trim() || null, sellerPhone: b.sellerPhone?.trim() || null, note: b.note?.trim() || null };
    if (!payload.sellerName && !payload.sellerPhone && !payload.note) throw field('note', 'Add who is selling it or what you saw.');
    await this.db.tx(async (c) => {
      await c.query(`insert into stolen_case_events (case_id, kind, actor_kind, actor_id, payload) values ($1, 'match_detail', 'checker', $2, $3)`, [ch.case_id, p.userId, payload]);
      const k = (await c.query(`select agency_id, public_no from stolen_cases where id = $1`, [ch.case_id])).rows[0];
      const staff = new Set([...(k.agency_id ? await agencyStaff(c, k.agency_id) : []), ...(ch.agency_id && ch.agency_id !== k.agency_id ? await agencyStaff(c, ch.agency_id) : [])]);
      await notify(c, [...staff], { type: 'stolen_match_detail', grp: 'reports', title: 'Buyer added details', body: `A buyer added details on the seller for ${k.public_no}.`, link: `/agency/stolen/${ch.case_id}` });
    });
    return { sent: true };
  }

  /** My checks: the reference is the buyer's proof they checked before buying. */
  async myChecks(p: Principal) {
    const r = await this.db.query(
      `select ch.id, ch.check_no, ch.result, ch.identifier, ch.at, t.label as type_label, t.identifier_label from item_checks ch join item_types t on t.code = ch.type_code
        where ch.checker_id = $1 order by ch.at desc limit 50`,
      [p.userId],
    );
    return r.rows.map((x) => ({ id: x.id, checkNo: x.check_no, result: x.result, typeLabel: x.type_label, identifierLabel: x.identifier_label, identifier: x.identifier, at: x.at }));
  }

  // ---------------------------------------------------------------- police

  private async police(p: Principal, agencyId: string, roles?: string[]) {
    await this.agencies.requireStaff(p, agencyId, roles);
    await this.agencies.requireHandles(agencyId, 'stolen');
  }

  /** Stolen-item cases for the agency, with buyer-check matches and the place filter (NIPOST levels). */
  async queue(p: Principal, agencyId: string, tab: 'open' | 'closed' | 'all', loc?: LocationFilter, range?: DateRange, typeCode?: string) {
    await this.police(p, agencyId);
    const args: unknown[] = [agencyId, OPEN];
    const states = tab === 'open' ? 'k.state = any($2::text[])' : tab === 'closed' ? 'not (k.state = any($2::text[]))' : '$2::text[] is not null';
    let type = 'true';
    if (typeCode) {
      args.push(typeCode);
      type = `k.type_code = $${args.length}`;
    }
    const r = await this.db.query(
      `select * from (select k.id, k.public_no, k.state, k.type_code, k.identifier, k.stolen_on, k.created_at, k.ownership_conflict, t.label as type_label, i.make, i.model,
              l.postcode, l.area_label, s.name as station,
              (select count(*)::int from item_checks ch where ch.case_id = k.id and ch.checker_id <> k.reporter_id) as matches,
              (select count(*)::int from item_checks ch where ch.case_id = k.id and ch.checker_id <> k.reporter_id
                  and not exists (select 1 from stolen_case_events e where e.case_id = k.id and e.kind = 'match_reviewed' and e.payload->>'checkId' = ch.id::text)) as new_matches,
              (select max(at) from item_checks ch where ch.case_id = k.id and ch.checker_id <> k.reporter_id) as last_match_at
         from stolen_cases k join owned_items i on i.id = k.item_id join item_types t on t.code = k.type_code
         left join locations l on l.id = k.location_id left join stations s on s.id = k.station_id
        where k.agency_id = $1 and ${states} and ${type} and ${locationWhere(loc, args)} and ${dateWhere(range, args, 'k.created_at')}
       ) x order by new_matches > 0 desc, coalesce(last_match_at, created_at) desc limit 300`,
      args,
    );
    return r.rows.map((k) => ({
      id: k.id,
      publicNo: k.public_no,
      state: k.state,
      stateLabel: stolenStateLabel[k.state as StolenState],
      type: k.type_code,
      typeLabel: k.type_label,
      name: itemName(k),
      identifier: k.identifier,
      stolenOn: k.stolen_on,
      createdAt: k.created_at,
      ownershipConflict: k.ownership_conflict,
      postcode: k.postcode,
      area: k.area_label,
      station: k.station,
      matches: k.matches,
      newMatches: k.new_matches,
      lastMatchAt: k.last_match_at,
    }));
  }

  /** Buyer checks that matched a stolen item: on this agency's cases, or made in this agency's area. */
  async matches(p: Principal, agencyId: string, tab: 'new' | 'reviewed' | 'all', loc?: LocationFilter, range?: DateRange) {
    await this.police(p, agencyId);
    const args: unknown[] = [agencyId];
    const reviewed = `exists (select 1 from stolen_case_events e where e.case_id = k.id and e.kind = 'match_reviewed' and e.payload->>'checkId' = ch.id::text)`;
    const r = await this.db.query(
      `select ch.id, ch.check_no, ch.context, ch.at, ch.accuracy_m, st_y(ch.geom::geometry) as lat, st_x(ch.geom::geometry) as lng, u.display_name as checker, u.phone as checker_phone,
              l.postcode, l.address_text, l.area_label, k.id as case_id, k.public_no, k.state, k.agency_id = $1 as our_case, i.make, i.model, t.label as type_label, ${reviewed} as reviewed,
              (select count(*)::int from stolen_case_events e where e.case_id = k.id and e.kind = 'match_detail' and e.payload->>'checkId' = ch.id::text) as details
         from item_checks ch join stolen_cases k on k.id = ch.case_id join owned_items i on i.id = k.item_id join item_types t on t.code = k.type_code
         join users u on u.id = ch.checker_id left join locations l on l.id = ch.location_id
        where ch.result = 'stolen' and ch.checker_id <> k.reporter_id and (k.agency_id = $1 or ch.agency_id = $1)
          and ${tab === 'new' ? `not ${reviewed}` : tab === 'reviewed' ? reviewed : 'true'}
          and ${locationWhere(loc, args)} and ${dateWhere(range, args, 'ch.at')}
        order by ch.at desc limit 300`,
      args,
    );
    return r.rows.map((m) => ({
      id: m.id,
      checkNo: m.check_no,
      context: m.context,
      at: m.at,
      checker: m.checker,
      checkerPhone: m.checker_phone,
      place: m.postcode ? `${m.address_text}, ${m.postcode}` : m.lat != null ? 'GPS only' : 'No location shared',
      postcode: m.postcode,
      area: m.area_label,
      lat: m.lat,
      lng: m.lng,
      accuracyM: m.accuracy_m,
      caseId: m.case_id,
      publicNo: m.public_no,
      caseState: m.state,
      ourCase: m.our_case,
      name: itemName(m),
      reviewed: m.reviewed,
      details: m.details,
    }));
  }

  /** May this agency open the case: it owns it, or a buyer check on it was made in its area. */
  private async caseFor(agencyId: string, caseId: string) {
    const k = (
      await this.db.query(
        `select k.*, i.make, i.model, i.colour, i.description, i.registered, i.created_at as item_registered_at, t.label as type_label, t.identifier_label, t.documents as type_docs,
                u.display_name as owner_name, u.phone as owner_phone, l.postcode, l.address_text, l.area_label, s.name as station
           from stolen_cases k join owned_items i on i.id = k.item_id join item_types t on t.code = k.type_code join users u on u.id = k.reporter_id
           left join locations l on l.id = k.location_id left join stations s on s.id = k.station_id
          where k.id = $1 and (k.agency_id = $2 or exists (select 1 from item_checks ch where ch.case_id = k.id and ch.agency_id = $2))`,
        [caseId, agencyId],
      )
    ).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Case not found.');
    return k;
  }

  async agencyDetail(p: Principal, agencyId: string, caseId: string) {
    await this.police(p, agencyId);
    const k = await this.caseFor(agencyId, caseId);
    const ours = k.agency_id === agencyId;
    const all = await this.matches(p, agencyId, 'all');
    const events = (await this.db.query(`select e.kind, e.actor_kind, e.payload, e.from_state, e.to_state, e.at, u.display_name from stolen_case_events e left join users u on u.id = e.actor_id where e.case_id = $1 order by e.id`, [caseId])).rows;
    const others = (
      await this.db.query(
        `select u.display_name, i.created_at from owned_items i join users u on u.id = i.owner_id where i.type_code = $1 and i.identifier = $2 and i.owner_id <> $3 and i.removed_at is null and i.registered`,
        [k.type_code, k.identifier, k.reporter_id],
      )
    ).rows;
    const docs = await this.documents(k.item_id, caseId, k.type_docs);
    await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: 'stolen.viewed', entity: 'stolen_case', entityId: caseId });
    const details = events.filter((e) => e.kind === 'match_detail');
    return {
      id: k.id,
      publicNo: k.public_no,
      state: k.state as StolenState,
      stateLabel: stolenStateLabel[k.state as StolenState],
      ours,
      agency: k.agency_label,
      station: k.station,
      item: {
        id: k.item_id,
        name: itemName(k),
        typeLabel: k.type_label,
        identifierLabel: k.identifier_label,
        identifier: k.identifier,
        make: k.make,
        model: k.model,
        colour: k.colour,
        description: k.description,
        registeredBefore: k.registered && new Date(k.item_registered_at) < new Date(k.created_at),
        registeredAt: k.registered ? k.item_registered_at : null,
      },
      // Another agency sees the case because of a check in its area; the owner's contact stays with the case's police.
      owner: ours ? { name: k.owner_name, phone: k.owner_phone } : null,
      stolenOn: k.stolen_on,
      circumstances: k.circumstances,
      policeReportNo: k.police_report_no,
      place: k.postcode ? `${k.address_text}, ${k.postcode}` : 'Location from GPS',
      postcode: k.postcode,
      area: k.area_label,
      ownershipConflict: k.ownership_conflict,
      alsoRegisteredBy: ours ? others.map((o) => ({ name: o.display_name, since: o.created_at })) : [],
      ...docs,
      matches: all
        .filter((m) => m.caseId === caseId)
        .map((m) => ({ ...m, sellerDetails: details.filter((d) => d.payload?.checkId === m.id).map((d) => ({ sellerName: d.payload.sellerName, sellerPhone: d.payload.sellerPhone, note: d.payload.note, at: d.at })) })),
      actions: ours ? availableEvents(stolenMachine, k.state, 'agency_admin') : [],
      history: events.map((e) => ({
        kind: e.kind,
        label: e.kind === 'match_reviewed' ? (e.payload?.outcome === 'dismissed' ? 'Match dismissed' : 'Match followed up') : (POLICE_LABEL[e.kind] ?? e.kind),
        by: e.actor_kind === 'agency' ? e.display_name : e.actor_kind === 'owner' ? 'Owner' : e.actor_kind === 'checker' ? 'Buyer' : 'System',
        note: e.payload?.note ?? (e.kind === 'withdraw' ? (e.payload?.reason === 'found' ? 'Owner has it back' : 'Reported by mistake') : null),
        at: e.at,
      })),
      createdAt: k.created_at,
    };
  }

  async act(p: Principal, agencyId: string, caseId: string, b: { event: Exclude<StolenEvent, 'withdraw'>; note?: string }) {
    await this.police(p, agencyId, ['agency_admin']);
    const k = (await this.db.query(`select reporter_id, public_no from stolen_cases where id = $1 and agency_id = $2`, [caseId, agencyId])).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Case not found.');
    const note = b.note?.trim() || null;
    if ((b.event === 'close' || b.event === 'recover') && !note) throw field('note', b.event === 'close' ? 'Say why the case is closed.' : 'Say where and how it was recovered.', 'note_required');
    return this.db.tx(async (c) => {
      const to = await this.transition(c, caseId, b.event, 'agency_admin', p.userId, { note });
      const body: Record<string, string> = {
        investigate: 'The police are investigating your stolen item.',
        locate: 'The police have located your item and are working to recover it.',
        recover: 'The police have recovered your item. They will contact you to return it. Bring your proof of ownership.',
        return_to_owner: 'Your item has been returned to you. Thank you for reporting it.',
        close: 'The police closed your case. Your item stays on the stolen list, so buyers are still warned.',
      };
      await notify(c, [k.reporter_id], { type: `stolen_${b.event}`, grp: 'reports', title: b.event === 'recover' ? 'Your item was recovered' : 'Update on your stolen item', body: body[b.event]!, link: `/stolen/${caseId}` });
      await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: `stolen.${b.event}`, entity: 'stolen_case', entityId: caseId }, c);
      return { state: to };
    });
  }

  /** Marks a buyer-check match as followed up or dismissed, with a note for the case log. */
  async reviewMatch(p: Principal, agencyId: string, caseId: string, checkId: string, b: { outcome: 'followed_up' | 'dismissed'; note?: string }) {
    await this.police(p, agencyId, ['agency_admin']);
    await this.caseFor(agencyId, caseId);
    const ch = (await this.db.query(`select 1 from item_checks where id = $1 and case_id = $2`, [checkId, caseId])).rowCount;
    if (!ch) throw new AppError(404, 'not_found', 'Match not found.');
    const done = await this.db.query(`select 1 from stolen_case_events where case_id = $1 and kind = 'match_reviewed' and payload->>'checkId' = $2`, [caseId, checkId]);
    if (done.rowCount) throw new AppError(409, 'already_reviewed', 'This match was already reviewed.');
    if (b.outcome === 'dismissed' && !b.note?.trim()) throw field('note', 'Say why the match is dismissed.', 'note_required');
    await this.db.query(`insert into stolen_case_events (case_id, kind, actor_kind, actor_id, payload) values ($1, 'match_reviewed', 'agency', $2, $3)`, [caseId, p.userId, { checkId, outcome: b.outcome, note: b.note?.trim() || null, agencyId }]);
    await this.audit.write({ actorId: p.userId, actorRole: 'agency', action: 'stolen.match_reviewed', entity: 'item_check', entityId: checkId, payload: { outcome: b.outcome } });
    return { reviewed: true };
  }
}
