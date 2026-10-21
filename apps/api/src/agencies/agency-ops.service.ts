// Agency boards: "Officers and add user", "Equipment inventory", "Routing rules", "Billing",
// "Infrastructure assets" (+ "Asset detail"), "Settings" and "Station detail". Access follows the
// role matrix: agency admins run operations; agency finance sees billing; nobody outside the agency
// learns it exists.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { formatNaira, ROLE_LABEL, type Role } from '@erp/domain';
import { POSTCODE, type PostcodeAdapter } from '../adapters/postcode';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { Audit } from '../core/audit';
import { requirePerm, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { locationWhere, type LocationFilter } from '../core/location-filter';
import { notify } from '../reports/shared';
import { AgenciesService } from './agencies.service';
import { AgencyBillingService } from './billing.service';

const OPEN = `('received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred', 'on_scene', 'closing')`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const EQUIPMENT = {
  vehicle: { fee: 'inventory_vehicle', label: 'Patrol vehicle' },
  ambulance: { fee: 'inventory_vehicle', label: 'Ambulance' },
  drone: { fee: 'inventory_drone_kit', label: 'Drone' },
  radio: { fee: 'inventory_radio', label: 'Handheld radio' },
  fire_drop_kit: { fee: 'inventory_fire_kit', label: 'Fire drop kit' },
} as const;
export type EquipmentKind = keyof typeof EQUIPMENT;
const EQUIP_STATUS: Record<string, string> = { ready: 'Ready', in_use: 'In use', needs_service: 'Needs service', out_of_service: 'Out of service' };
const ASSET_KIND: Record<string, string> = { traffic_light: 'Traffic light', street_light: 'Street light', camera: 'Camera' };
const ASSET_STATUS: Record<string, string> = { online: 'Online', low_power: 'Low power', offline: 'Offline', fault: 'Fault' };
const ACTION_LABEL: Record<string, string> = { restart: 'Restart controller', flashing_amber: 'Set flashing amber', manual_control: 'Manual control' };
export const AGENCY_TEAM_ROLES = ['agency_admin', 'agency_finance', 'head', 'dispatcher'] as const;

@Injectable()
export class AgencyOpsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(SMS) private readonly sms: SmsAdapter,
    @Inject(POSTCODE) private readonly postcode: PostcodeAdapter,
    @Inject(AgenciesService) private readonly agencies: AgenciesService,
    @Inject(AgencyBillingService) private readonly billing: AgencyBillingService,
  ) {}

  private async station(c: Queryable, agencyId: string, stationId: string) {
    const s = (await c.query(`select id, name from stations where id = $1 and agency_id = $2`, [stationId, agencyId])).rows[0];
    if (!s) throw new AppError(422, 'validation_failed', 'Choose one of your stations.', { fields: [{ field: 'stationId', message: 'Choose one of your stations.' }] });
    return s as { id: string; name: string };
  }

  private async userByPhone(c: Queryable, phone: string, name?: string) {
    const ph = phone.replace(/\s+/g, '');
    if (!/^\+234\d{10}$/.test(ph)) throw new AppError(422, 'validation_failed', 'Enter a Nigerian phone number, like +2348012345678.', { fields: [{ field: 'phone', message: 'Enter a Nigerian phone number.' }] });
    const u = (await c.query(`select id, display_name from users where phone = $1`, [ph])).rows[0];
    if (u) return { id: u.id as string, phone: ph, created: false };
    if (!name?.trim()) throw new AppError(422, 'validation_failed', 'Enter their full name.', { fields: [{ field: 'name', message: 'Enter their full name.' }] });
    return { id: (await c.query(`insert into users (phone, display_name) values ($1, $2) returning id`, [ph, name.trim()])).rows[0].id as string, phone: ph, created: true };
  }

  // ---------------------------------------------------------------- officers

  async officers(p: Principal, agencyId: string, f: LocationFilter) {
    requirePerm(p, 'agency.operations', agencyId);
    const args: unknown[] = [agencyId];
    const where = locationWhere(f, args);
    const r = await this.db.query(
      `select o.user_id as id, u.display_name as name, u.phone, o.badge_no, o.rank, o.badge_status, o.on_duty, o.invited_at, s.id as station_id, s.name as station,
              exists (select 1 from user_roles ur where ur.user_id = o.user_id and ur.role = 'head' and ur.scope_id = s.id) as is_head,
              (select round(avg(rt.stars)::numeric, 1) from ratings rt join incident_units x on x.incident_id = rt.incident_id where x.officer_id = o.user_id) as rating,
              (select coalesce(sum((sh->>'kobo')::bigint), 0) from reward_payments rp, jsonb_array_elements(rp.shares) sh where rp.state = 'paid' and sh->>'id' = o.user_id::text) as rewards,
              exists (select 1 from incident_units x where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene')) as busy
         from officers o join stations s on s.id = o.station_id join users u on u.id = o.user_id left join locations l on l.id = s.location_id
        where s.agency_id = $1 and ${where}
        order by s.name, is_head desc, u.display_name`,
      args,
    );
    const stations = (await this.db.query(`select id, name from stations where agency_id = $1 order by name`, [agencyId])).rows;
    return {
      stations,
      items: r.rows.map((o) => ({
        id: o.id,
        name: o.name,
        badgeNo: o.badge_no,
        rank: o.rank,
        station: o.station,
        stationId: o.station_id,
        role: o.is_head ? 'Station head' : 'Officer',
        rating: o.rating == null ? null : Number(o.rating),
        rewardsKobo: Number(o.rewards),
        status: o.badge_status !== 'verified' ? 'invited' : o.busy ? 'busy' : o.on_duty ? 'on_duty' : 'off_duty',
      })),
    };
  }

  /** "Add officer": an invite by phone; they verify their identity before receiving reports. */
  async inviteOfficer(p: Principal, agencyId: string, b: { name: string; serviceNo: string; phone: string; stationId: string; role: 'officer' | 'head' }) {
    requirePerm(p, 'agency.operations', agencyId);
    return this.db.tx(async (c) => {
      const st = await this.station(c, agencyId, b.stationId);
      const u = await this.userByPhone(c, b.phone, b.name);
      const already = (await c.query(`select station_id from officers where user_id = $1`, [u.id])).rows[0];
      if (already) throw new AppError(409, 'already_officer', 'This person is already an officer.');
      const dup = await c.query(`select 1 from officers where station_id = $1 and badge_no = $2`, [b.stationId, b.serviceNo.trim()]);
      if (dup.rowCount) throw new AppError(422, 'validation_failed', 'That service number is already used at this station.', { fields: [{ field: 'serviceNo', message: 'Already used at this station.' }] });
      const kyc = (await c.query(`select 1 from kyc_verifications where user_id = $1 and status = 'verified' limit 1`, [u.id])).rowCount;
      await c.query(`insert into officers (user_id, station_id, badge_no, badge_status, invited_at) values ($1, $2, $3, $4, now())`, [u.id, b.stationId, b.serviceNo.trim(), kyc ? 'verified' : 'pending']);
      await c.query(`insert into user_roles (user_id, role, scope_type, scope_id) values ($1, 'officer', 'station', $2)`, [u.id, b.stationId]);
      if (b.role === 'head') {
        await c.query(`insert into user_roles (user_id, role, scope_type, scope_id) values ($1, 'head', 'station', $2)`, [u.id, b.stationId]);
        await c.query(`update stations set head_user_id = $2 where id = $1`, [b.stationId, u.id]);
      }
      await notify(c, [u.id], { type: 'officer_invited', grp: 'team', title: `You were added to ${st.name}`, body: 'Verify your identity in the app to start receiving reports.', link: '/officer/badge' });
      await this.sms.send({ to: u.phone, body: `You were added as ${b.role === 'head' ? 'station head' : 'an officer'} at ${st.name}. Open the ERP app with this number and verify your identity to start.`, urgent: false }).catch(() => undefined);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'officer.invite', entity: 'station', entityId: b.stationId, payload: { userId: u.id, role: b.role } }, c);
      return { id: u.id, message: kyc ? `${b.name.trim()} was added to ${st.name}.` : `Invite sent. ${b.name.trim()} verifies their identity before receiving reports.` };
    });
  }

  // ---------------------------------------------------------------- equipment

  async equipment(p: Principal, agencyId: string, f: LocationFilter) {
    requirePerm(p, 'agency.operations', agencyId);
    const args: unknown[] = [agencyId];
    const where = locationWhere(f, args);
    const r = await this.db.query(
      `select i.id, i.fee_code, i.name, i.quantity, i.status, i.last_check_at, i.pilot_name, i.created_at, s.name as station, i.station_id, af.label as fee_label
         from agency_inventory i left join stations s on s.id = i.station_id left join locations l on l.id = s.location_id join agency_fees af on af.code = i.fee_code
        where i.agency_id = $1 and i.removed_at is null and (${where === 'true' ? 'true' : `(${where})`})
        order by s.name nulls first, i.created_at`,
      args,
    );
    const ready = (code: string) => r.rows.filter((x) => x.fee_code === code && x.status === 'ready').reduce((a, x) => a + x.quantity, 0);
    const overdue = (x: { last_check_at: Date | null }) => !x.last_check_at || +new Date(x.last_check_at) < Date.now() - 30 * 86_400_000;
    return {
      kinds: Object.entries(EQUIPMENT).map(([code, e]) => ({ code, label: e.label })),
      stats: {
        vehiclesReady: ready('inventory_vehicle'),
        dronesReady: ready('inventory_drone_kit'),
        dronePilots: r.rows.filter((x) => x.fee_code === 'inventory_drone_kit' && x.pilot_name).length,
        fireKits: ready('inventory_fire_kit'),
        needsService: r.rows.filter((x) => x.status === 'needs_service' || overdue(x)).length,
      },
      items: r.rows.map((x) => ({
        id: x.id,
        name: x.name ?? x.fee_label,
        station: x.station ?? 'Agency store',
        stationId: x.station_id,
        count: x.quantity,
        status: x.status,
        statusLabel: EQUIP_STATUS[x.status],
        lastCheck: x.last_check_at,
        checkOverdue: overdue(x),
        pilot: x.pilot_name,
      })),
    };
  }

  async addEquipment(p: Principal, agencyId: string, b: { kind: EquipmentKind; name?: string; quantity: number; stationId?: string; pilotName?: string }) {
    requirePerm(p, 'agency.operations', agencyId);
    const e = EQUIPMENT[b.kind];
    const r = await this.agencies.addInventory(p, agencyId, { feeCode: e.fee, quantity: b.quantity, stationId: b.stationId });
    await this.db.query(`update agency_inventory set name = $2, pilot_name = $3, last_check_at = now() where id = $1`, [r.id, b.name?.trim() || e.label, b.kind === 'drone' ? b.pilotName?.trim() || null : null]);
    return { id: r.id, message: `Added. ${r.monthly} a month from the next invoice.` };
  }

  async updateEquipment(p: Principal, agencyId: string, id: string, b: { status?: string; checked?: boolean; pilotName?: string; remove?: boolean }) {
    requirePerm(p, 'agency.operations', agencyId);
    const r = await this.db.query(
      `update agency_inventory set status = coalesce($3, status), last_check_at = case when $4 then now() else last_check_at end,
              pilot_name = coalesce($5, pilot_name), removed_at = case when $6 then now() else removed_at end
        where id = $1 and agency_id = $2 and removed_at is null returning id`,
      [id, agencyId, b.status ?? null, !!b.checked, b.pilotName ?? null, !!b.remove],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Item not found.');
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: b.remove ? 'inventory.remove' : 'inventory.update', entity: 'agency', entityId: agencyId, payload: { id, ...b } });
    return { message: b.remove ? 'Removed. Its fee stops from the next invoice.' : b.checked ? 'Check recorded.' : 'Saved.' };
  }

  // ---------------------------------------------------------------- routing rules

  async routing(p: Principal, agencyId: string) {
    requirePerm(p, 'agency.operations', agencyId);
    const a = (await this.db.query(`select kind, settings from agencies where id = $1`, [agencyId])).rows[0];
    const rules = (
      await this.db.query(
        `select r.id, r.incident_type, r.area_id, r.priority, r.wait_seconds, r.active, s.name as station, r.station_id, n.name as next_station, r.next_station_id, t.label as type_label,
                coalesce((select sa.label from station_areas sa where sa.area_id = r.area_id and sa.label is not null limit 1), (select area_label from locations where area_id = r.area_id limit 1), r.area_id) as area_label
           from routing_rules r join stations s on s.id = r.station_id left join stations n on n.id = r.next_station_id left join incident_types t on t.code = r.incident_type
          where s.agency_id = $1 order by r.incident_type, r.priority`,
        [agencyId],
      )
    ).rows;
    const types = (await this.db.query(`select code, label from incident_types where $1 = any(default_units) order by label`, [a.kind])).rows;
    const stations = (await this.db.query(`select id, name from stations where agency_id = $1 and status <> 'paused' order by name`, [agencyId])).rows;
    return {
      defaults: { acceptSeconds: a.settings.acceptSeconds ?? 25, ifNobodyAccepts: a.settings.ifNobodyAccepts ?? 'next_nearest', nightHandover: a.settings.nightHandover ?? '19:00' },
      types,
      stations,
      rules: rules.map((r) => ({
        id: r.id,
        type: r.incident_type,
        typeLabel: r.type_label ?? cap(r.incident_type),
        area: r.area_id,
        areaLabel: r.area_id ? r.area_label : 'All areas',
        station: r.station,
        stationId: r.station_id,
        next: r.next_station,
        nextStationId: r.next_station_id,
        waitSeconds: r.wait_seconds,
        priority: r.priority,
        active: r.active,
      })),
    };
  }

  async saveRule(p: Principal, agencyId: string, b: { id?: string; incidentType: string; areaId?: string | null; stationId: string; nextStationId?: string | null; waitSeconds: number; priority: number; active?: boolean }) {
    requirePerm(p, 'agency.operations', agencyId);
    return this.db.tx(async (c) => {
      await this.station(c, agencyId, b.stationId);
      if (b.nextStationId) await this.station(c, agencyId, b.nextStationId);
      if (b.nextStationId === b.stationId) throw new AppError(422, 'validation_failed', 'The next station must be a different one.', { fields: [{ field: 'nextStationId', message: 'Choose a different station.' }] });
      const kind = (await c.query(`select kind from agencies where id = $1`, [agencyId])).rows[0].kind;
      const t = await c.query(`select 1 from incident_types where code = $1 and $2 = any(default_units)`, [b.incidentType, kind]);
      if (!t.rowCount) throw new AppError(422, 'validation_failed', 'Choose a report type your agency handles.', { fields: [{ field: 'incidentType', message: 'Choose a report type.' }] });
      let id = b.id;
      try {
        if (id) {
          const r = await c.query(
            `update routing_rules r set incident_type = $2, area_id = $3, station_id = $4, next_station_id = $5, wait_seconds = $6, priority = $7, active = coalesce($8, active), updated_by = $9, updated_at = now()
              from stations s where r.id = $1 and s.id = r.station_id and s.agency_id = $10 returning r.id`,
            [id, b.incidentType, b.areaId || null, b.stationId, b.nextStationId || null, b.waitSeconds, b.priority, b.active ?? null, p.userId, agencyId],
          );
          if (!r.rowCount) throw new AppError(404, 'not_found', 'Rule not found.');
        } else {
          id = (
            await c.query(
              `insert into routing_rules (incident_type, area_id, station_id, next_station_id, wait_seconds, priority, active, updated_by) values ($1, $2, $3, $4, $5, $6, coalesce($7, true), $8) returning id`,
              [b.incidentType, b.areaId || null, b.stationId, b.nextStationId || null, b.waitSeconds, b.priority, b.active ?? null, p.userId],
            )
          ).rows[0].id;
        }
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError(409, 'duplicate_rule', 'A rule for this type, area and priority already exists. Change the priority or edit that rule.');
        throw e;
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'routing.rule_set', entity: 'routing_rule', entityId: id, payload: b }, c);
      return { id, message: b.id ? 'Rule saved.' : 'Rule added. New reports use it now.' };
    });
  }

  async saveDefaults(p: Principal, agencyId: string, b: { acceptSeconds?: number; ifNobodyAccepts?: string; nightHandover?: string }) {
    requirePerm(p, 'agency.operations', agencyId);
    await this.db.tx(async (c) => {
      await c.query(`update agencies set settings = settings || $2::jsonb where id = $1`, [agencyId, JSON.stringify(b)]);
      // The accept window applies to every station of the agency.
      if (b.acceptSeconds) await c.query(`update stations set accept_window_seconds = $2 where agency_id = $1`, [agencyId, b.acceptSeconds]);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'routing.defaults', entity: 'agency', entityId: agencyId, payload: b }, c);
    });
    return { message: 'Saved.' };
  }

  /** "Test a postcode": who would get this report type at this building, first and next. */
  async testRoute(p: Principal, agencyId: string, b: { postcode: string; type: string }) {
    requirePerm(p, 'agency.operations', agencyId);
    let place = (await this.db.query(`select lga_id, district_id, area_id, area_label, st_y(geom::geometry) as lat, st_x(geom::geometry) as lng from locations where replace(postcode, ' ', '') = replace($1, ' ', '')`, [b.postcode])).rows[0];
    if (!place) {
      const x = await this.postcode.lookup(b.postcode).catch(() => null);
      if (!x) throw new AppError(404, 'postcode_not_found', 'No building found for this postcode.', { fields: [{ field: 'postcode', message: 'No building found.' }] });
      place = { lga_id: x.lgaId, district_id: x.districtId, area_id: x.areaId, area_label: x.areaLabel, lat: x.lat, lng: x.lng };
    }
    const r = await this.db.query(
      `with pt as (select st_setsrid(st_makepoint($6, $5), 4326)::geography as g)
       select s.id, s.name,
              (select min(rr.priority) from routing_rules rr where rr.active and rr.station_id = s.id and rr.incident_type = $2 and rr.area_id in ($3, $4, $7)) as area_rule,
              (coalesce(st_covers(s.zone, pt.g), false) or exists (select 1 from station_areas sa where sa.station_id = s.id
                 and ((sa.level = 'area' and sa.area_id = $4) or (sa.level = 'district' and sa.area_id = $3) or (sa.level = 'lga' and sa.area_id = $7)))) as covers,
              (select min(rr.priority) from routing_rules rr where rr.active and rr.station_id = s.id and rr.incident_type = $2 and rr.area_id is null) as rule,
              st_distance(coalesce(s.zone::geometry, (select geom::geometry from locations where id = s.location_id))::geography, pt.g) as d,
              (select n.name from routing_rules rr join stations n on n.id = rr.next_station_id where rr.active and rr.station_id = s.id and rr.incident_type = $2 order by rr.priority limit 1) as fallback
         from stations s cross join pt where s.agency_id = $1 and s.status = 'active'
        order by case when (select min(rr.priority) from routing_rules rr where rr.active and rr.station_id = s.id and rr.incident_type = $2 and rr.area_id in ($3, $4, $7)) is not null then 0
                      when coalesce(st_covers(s.zone, pt.g), false) or exists (select 1 from station_areas sa where sa.station_id = s.id
                        and ((sa.level = 'area' and sa.area_id = $4) or (sa.level = 'district' and sa.area_id = $3) or (sa.level = 'lga' and sa.area_id = $7))) then 1 else 2 end,
                 rule nulls last, d nulls last`,
      [agencyId, b.type, place.district_id, place.area_id, place.lat, place.lng, place.lga_id],
    );
    if (!r.rows.length) return { first: null, then: null, why: 'Your agency has no active station yet.' };
    const first = r.rows[0];
    const then = first.fallback ?? r.rows[1]?.name ?? null;
    const why = first.area_rule != null ? 'A routing rule covers this area.' : first.covers ? "The building is inside this station's area." : 'No station covers this area, so the nearest station gets it.';
    return { first: first.name, then, why, area: place.area_label };
  }

  // ---------------------------------------------------------------- billing

  async billingSummary(p: Principal, agencyId: string) {
    requirePerm(p, 'agency.money', agencyId);
    const invoices = await this.billing.listInvoices(p, agencyId);
    const a = (await this.db.query(`select status, period_end from agencies where id = $1`, [agencyId])).rows[0];
    const inv = (
      await this.db.query(
        `select coalesce(sum(i.quantity * coalesce(o.amount_kobo, f.amount_kobo)), 0)::bigint as kobo, coalesce(sum(i.quantity), 0)::int as items
           from agency_inventory i join agency_fees f on f.code = i.fee_code left join agency_price_overrides o on o.agency_id = i.agency_id and o.code = i.fee_code
          where i.agency_id = $1 and i.removed_at is null`,
        [agencyId],
      )
    ).rows[0];
    const prices = await this.billing.prices(this.db.pool, agencyId);
    const onboarding = invoices.find((i) => i.kind === 'onboarding');
    const open = invoices.filter((i) => ['issued', 'overdue'].includes(i.state));
    const checklist = (
      await this.db.query(
        `select (select count(*) from agency_documents d where d.agency_id = $1 and d.superseded_at is null and d.status = 'accepted') > 0 as docs,
                exists (select 1 from invoices where agency_id = $1 and kind = 'onboarding' and state = 'paid') as paid,
                exists (select 1 from agencies ag join kyc_verifications k on k.user_id = ag.contact_user_id and k.status = 'verified' where ag.id = $1) as head_verified`,
        [agencyId],
      )
    ).rows[0];
    const method = (await this.db.query(`select method, provider_ref from payments where agency_id = $1 and state = 'succeeded' order by paid_at desc nulls last limit 1`, [agencyId])).rows[0];
    return {
      stats: {
        onboardingKobo: onboarding?.totalKobo ?? Number(prices.onboarding?.amountKobo ?? 0),
        onboardingPaidAt: onboarding?.paidAt ?? null,
        inventoryMonthKobo: Number(inv.kobo),
        inventoryItems: inv.items,
        balanceKobo: open.reduce((s, i) => s + i.balanceKobo, 0),
        balanceDueOn: open.map((i) => i.dueOn).sort()[0] ?? null,
        nextInvoiceOn: a.period_end,
      },
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, kind: i.kind, state: i.state, dueOn: i.dueOn, totalKobo: i.totalKobo, balanceKobo: i.balanceKobo, lines: i.lines, paidAt: i.paidAt })),
      fees: Object.values(prices)
        .filter((x) => x.code === 'onboarding' || x.code === 'station_overage' || x.code.startsWith('inventory_'))
        .map((x) => ({ code: x.code, label: x.label, amountKobo: Number(x.amountKobo), amount: formatNaira(Number(x.amountKobo)), per: x.code === 'onboarding' ? 'One time, with document check' : x.code === 'station_overage' ? 'Each extra station, monthly' : 'Per item, monthly' })),
      paymentMethod: method ? { method: method.method, reference: String(method.provider_ref).slice(-4) } : null,
      checklist: { documentsApproved: checklist.docs, onboardingPaid: checklist.paid, headVerified: checklist.head_verified },
      openInvoiceId: open[0]?.id ?? null,
    };
  }

  async invoicesCsv(p: Principal, agencyId: string) {
    const b = await this.billingSummary(p, agencyId);
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return ['Number,Kind,Due,Total (NGN),Balance (NGN),Status', ...b.invoices.map((i) => [i.number, i.kind, i.dueOn, (i.totalKobo / 100).toFixed(2), (i.balanceKobo / 100).toFixed(2), i.state].map(q).join(','))].join('\n');
  }

  // ---------------------------------------------------------------- infrastructure assets

  async assets(p: Principal, agencyId: string, b: { tab?: string } & LocationFilter) {
    requirePerm(p, 'agency.operations', agencyId);
    const args: unknown[] = [agencyId];
    const where = locationWhere(b, args);
    const r = await this.db.query(
      `select a.*, l.postcode, l.lga_id, l.area_label,
              (select count(*)::int from asset_faults f where f.asset_id = a.id and f.closed_at is null) as open_faults,
              (select count(*)::int from issue_reports ir join issue_cases ic on ic.id = ir.case_id where st_dwithin(ic.geom, l.geom, 60) and ir.created_at > now() - interval '7 days') as citizen_reports
         from agency_assets a left join locations l on l.id = a.location_id
        where a.agency_id = $1 and (${where === 'true' ? 'true' : `(${where})`})
        order by case a.status when 'fault' then 0 when 'offline' then 1 when 'low_power' then 2 else 3 end, a.name`,
      args,
    );
    const all = r.rows;
    const today = new Date().toISOString().slice(0, 10);
    const overdue = (x: { next_service_on: Date | null }) => !!x.next_service_on && new Date(x.next_service_on).toISOString().slice(0, 10) < today;
    const tab = b.tab ?? 'all';
    const pick = (x: (typeof all)[number]) =>
      tab === 'all' ? true : tab === 'faults' ? x.status === 'fault' || x.open_faults > 0 : tab === 'overdue' ? overdue(x) : x.kind === tab;
    const online = all.filter((x) => x.last_signal_at && +new Date(x.last_signal_at) > Date.now() - 86_400_000 && x.status !== 'offline').length;
    return {
      stats: {
        total: all.length,
        traffic: all.filter((x) => x.kind === 'traffic_light').length,
        street: all.filter((x) => x.kind === 'street_light').length,
        camera: all.filter((x) => x.kind === 'camera').length,
        onlinePct: all.length ? Math.round((online / all.length) * 100) : 0,
        openFaults: all.filter((x) => x.status === 'fault' || x.open_faults > 0).length,
        citizenReported: all.filter((x) => x.citizen_reports > 0).length,
        overdue: all.filter(overdue).length,
      },
      items: all.filter(pick).map((x) => ({
        id: x.id,
        name: x.name,
        kind: x.kind,
        kindLabel: ASSET_KIND[x.kind],
        area: [x.lga_id, x.postcode].filter(Boolean).join(', '),
        status: x.status,
        statusLabel: ASSET_STATUS[x.status],
        lastSignal: x.last_signal_at,
        nextService: x.next_service_on,
        serviceOverdue: overdue(x),
        citizenReports: x.citizen_reports,
      })),
    };
  }

  async asset(p: Principal, agencyId: string, id: string) {
    requirePerm(p, 'agency.operations', agencyId);
    const a = (
      await this.db.query(
        `select a.*, l.postcode, l.address_text, u.display_name as plan_changed_by_name, ag.settings->>'safetyPlanSigned' as safety
           from agency_assets a left join locations l on l.id = a.location_id left join users u on u.id = a.plan_changed_by join agencies ag on ag.id = a.agency_id
          where a.id = $1 and a.agency_id = $2`,
        [id, agencyId],
      )
    ).rows[0];
    if (!a) throw new AppError(404, 'not_found', 'Asset not found.');
    const faults = (await this.db.query(`select id, what, opened_at, closed_at, fix from asset_faults where asset_id = $1 order by opened_at desc limit 20`, [id])).rows;
    const orders = (await this.db.query(`select w.number, w.kind, w.state, w.note, w.created_at, u.display_name as by from asset_work_orders w join users u on u.id = w.created_by where w.asset_id = $1 order by w.created_at desc limit 10`, [id])).rows;
    const actions = (
      await this.db.query(
        `select x.id, x.action, x.state, x.created_at, ru.display_name as requested_by, x.requested_by as requested_by_id, au.display_name as approved_by
           from asset_actions x join users ru on ru.id = x.requested_by left join users au on au.id = x.approved_by where x.asset_id = $1 order by x.created_at desc limit 10`,
        [id],
      )
    ).rows;
    const open = faults.find((f) => !f.closed_at);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      kindLabel: ASSET_KIND[a.kind],
      postcode: a.postcode,
      address: a.address_text,
      status: a.status,
      statusLabel: ASSET_STATUS[a.status],
      fault: a.fault_detail,
      lastSignal: a.last_signal_at,
      power: a.power,
      batteryPct: a.battery_pct,
      controller: a.controller,
      installedOn: a.installed_on,
      maintenance: { lastService: a.last_service_on, nextService: a.next_service_on, warrantyUntil: a.warranty_until },
      signalPlan: a.signal_plan,
      planChanged: a.plan_changed_at ? { at: a.plan_changed_at, by: a.plan_changed_by_name } : null,
      openFault: open ? { since: open.opened_at, what: open.what } : null,
      faults: faults.map((f) => ({ at: f.opened_at, what: f.closed_at ? `${f.what}${f.fix ? `, ${f.fix}` : ', fixed'}` : `${f.what} (open)` })),
      workOrders: orders.map((w) => ({ number: w.number, kind: w.kind, state: w.state, note: w.note, at: w.created_at, by: w.by })),
      actions: actions.map((x) => ({ id: x.id, action: x.action, label: ACTION_LABEL[x.action], state: x.state, at: x.created_at, requestedBy: x.requested_by, approvedBy: x.approved_by, canApprove: x.state === 'awaiting_approval' && x.requested_by_id !== p.userId })),
      safetyPlanSigned: a.safety === 'true',
    };
  }

  async addAsset(p: Principal, agencyId: string, b: { kind: 'traffic_light' | 'street_light' | 'camera'; name: string; postcode?: string; controller?: string; nextServiceOn?: string }) {
    requirePerm(p, 'agency.operations', agencyId);
    return this.db.tx(async (c) => {
      let loc: string | null = null;
      if (b.postcode?.trim()) {
        loc = (await c.query(`select id from locations where replace(postcode, ' ', '') = replace($1, ' ', '')`, [b.postcode])).rows[0]?.id ?? null;
        if (!loc) {
          const x = await this.postcode.lookup(b.postcode).catch(() => null);
          if (!x) throw new AppError(422, 'validation_failed', 'No building found for this postcode.', { fields: [{ field: 'postcode', message: 'No building found.' }] });
          loc = (
            await c.query(
              `insert into locations (postcode, address_text, state_id, lga_id, district_id, area_id, area_label, geom) values ($1, $2, $3, $4, $5, $6, $7, st_setsrid(st_makepoint($9, $8), 4326)::geography)
               on conflict (postcode) do update set fetched_at = now() returning id`,
              [x.postcode, x.address, x.stateId, x.lgaId, x.districtId, x.areaId, x.areaLabel, x.lat, x.lng],
            )
          ).rows[0].id;
        }
      }
      try {
        const id = (
          await c.query(
            `insert into agency_assets (agency_id, kind, name, location_id, controller, next_service_on, installed_on, last_signal_at) values ($1, $2, $3, $4, $5, $6, current_date, now()) returning id`,
            [agencyId, b.kind, b.name.trim(), loc, b.controller?.trim() || null, b.nextServiceOn || null],
          )
        ).rows[0].id;
        await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'asset.add', entity: 'asset', entityId: id, payload: { kind: b.kind, name: b.name } }, c);
        return { id, message: 'Asset added.' };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError(409, 'duplicate', 'You already have an asset with this name.', { fields: [{ field: 'name', message: 'Already used.' }] });
        throw e;
      }
    });
  }

  /** "Import list": one asset per line, `kind, name, postcode`. Lines that fail are listed back. */
  async importAssets(p: Principal, agencyId: string, csv: string) {
    requirePerm(p, 'agency.operations', agencyId);
    const KINDS: Record<string, 'traffic_light' | 'street_light' | 'camera'> = { 'traffic light': 'traffic_light', traffic_light: 'traffic_light', 'street light': 'street_light', street_light: 'street_light', camera: 'camera' };
    let added = 0;
    const failed: { line: number; reason: string }[] = [];
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const [i, line] of lines.entries()) {
      if (i === 0 && /^kind\s*,/i.test(line)) continue;
      const [k, name, pc] = line.split(',').map((x) => x.trim());
      const kind = KINDS[(k ?? '').toLowerCase()];
      if (!kind || !name) {
        failed.push({ line: i + 1, reason: 'Needs a kind (traffic light, street light or camera) and a name.' });
        continue;
      }
      try {
        await this.addAsset(p, agencyId, { kind, name, postcode: pc });
        added++;
      } catch (e) {
        failed.push({ line: i + 1, reason: e instanceof AppError ? (e.getResponse() as { message: string }).message : 'Could not add.' });
      }
    }
    return { added, failed, message: `${added} added${failed.length ? `, ${failed.length} not added` : ''}.` };
  }

  async workOrder(p: Principal, agencyId: string, assetId: string, b: { kind: 'repair' | 'service' | 'inspection' | 'replace'; note?: string }) {
    requirePerm(p, 'agency.operations', agencyId);
    return this.db.tx(async (c) => {
      const a = (await c.query(`select id, name from agency_assets where id = $1 and agency_id = $2`, [assetId, agencyId])).rows[0];
      if (!a) throw new AppError(404, 'not_found', 'Asset not found.');
      let number = '';
      for (;;) {
        number = `WO-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from asset_work_orders where number = $1`, [number])).rowCount) break;
      }
      await c.query(`insert into asset_work_orders (number, asset_id, kind, note, created_by) values ($1, $2, $3, $4, $5)`, [number, assetId, b.kind, b.note?.trim() || null, p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'asset.work_order', entity: 'asset', entityId: assetId, payload: { number, kind: b.kind } }, c);
      return { number, message: `Work order ${number} created for ${a.name}.` };
    });
  }

  /** Remote actions on a traffic light: only once the safety plan is signed, and a second admin must approve. */
  async requestAction(p: Principal, agencyId: string, assetId: string, action: 'restart' | 'flashing_amber' | 'manual_control') {
    requirePerm(p, 'agency.operations', agencyId);
    return this.db.tx(async (c) => {
      const a = (await c.query(`select a.kind, a.name, ag.settings->>'safetyPlanSigned' as safety from agency_assets a join agencies ag on ag.id = a.agency_id where a.id = $1 and a.agency_id = $2`, [assetId, agencyId])).rows[0];
      if (!a) throw new AppError(404, 'not_found', 'Asset not found.');
      if (a.kind !== 'traffic_light') throw new AppError(422, 'not_traffic_light', 'Remote actions are for traffic lights.');
      if (a.safety !== 'true') throw new AppError(409, 'safety_plan', 'Remote changes are off until your agency signs the safety plan in Settings.');
      const id = (await c.query(`insert into asset_actions (asset_id, action, requested_by) values ($1, $2, $3) returning id`, [assetId, action, p.userId])).rows[0].id;
      const others = (await c.query(`select user_id from user_roles where role = 'agency_admin' and scope_id = $1 and user_id <> $2`, [agencyId, p.userId])).rows.map((x) => x.user_id);
      await notify(c, others, { type: 'asset_action', grp: 'team', title: 'Second approval needed', body: `${ACTION_LABEL[action]} at ${a.name}.`, link: `/agency/assets/${assetId}` });
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'asset.action_requested', entity: 'asset', entityId: assetId, payload: { action } }, c);
      return { id, message: others.length ? 'Asked. Another agency admin must approve it.' : 'Asked. Add a second agency admin so someone can approve it.' };
    });
  }

  async approveAction(p: Principal, agencyId: string, actionId: string, approve: boolean) {
    requirePerm(p, 'agency.operations', agencyId);
    return this.db.tx(async (c) => {
      const x = (
        await c.query(`select x.*, a.name from asset_actions x join agency_assets a on a.id = x.asset_id where x.id = $1 and a.agency_id = $2 for update of x`, [actionId, agencyId])
      ).rows[0];
      if (!x) throw new AppError(404, 'not_found', 'Not found.');
      if (x.state !== 'awaiting_approval') throw new AppError(409, 'not_waiting', 'Already decided.');
      if (x.requested_by === p.userId) throw new AppError(403, 'second_approver', 'A different agency admin must approve it.');
      await c.query(`update asset_actions set state = $2, approved_by = $3 where id = $1`, [actionId, approve ? 'done' : 'refused', p.userId]);
      if (approve && x.action === 'flashing_amber') await c.query(`update agency_assets set signal_plan = signal_plan || '{"override": "Flashing amber"}', plan_changed_at = now(), plan_changed_by = $2 where id = $1`, [x.asset_id, p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: approve ? 'asset.action_approved' : 'asset.action_refused', entity: 'asset', entityId: x.asset_id, payload: { action: x.action, approvedBy: p.userId } }, c);
      return { message: approve ? `${ACTION_LABEL[x.action]} sent to ${x.name}.` : 'Refused.' };
    });
  }

  // ---------------------------------------------------------------- settings and team

  async settings(p: Principal, agencyId: string) {
    requirePerm(p, 'agency.view', agencyId);
    const a = (
      await this.db.query(`select a.name, a.kind, a.status, a.contact_phone, a.contact_email, a.official_email, a.settings, a.pending_profile, l.postcode from agencies a left join locations l on l.id = a.location_id where a.id = $1`, [agencyId])
    ).rows[0];
    const team = (
      await this.db.query(
        `select ur.role, count(distinct ur.user_id)::int as n from user_roles ur
          where (ur.scope_type = 'agency' and ur.scope_id = $1) or (ur.scope_type = 'station' and ur.scope_id in (select id from stations where agency_id = $1)) group by ur.role`,
        [agencyId],
      )
    ).rows;
    const members = (
      await this.db.query(
        `select u.id, u.display_name as name, u.phone, ur.role, s.name as station from user_roles ur join users u on u.id = ur.user_id left join stations s on ur.scope_type = 'station' and s.id = ur.scope_id
          where ((ur.scope_type = 'agency' and ur.scope_id = $1) or (ur.scope_type = 'station' and ur.scope_id in (select id from stations where agency_id = $1))) and ur.role <> 'officer'
          order by ur.role, u.display_name`,
        [agencyId],
      )
    ).rows;
    const stations = (await this.db.query(`select id, name from stations where agency_id = $1 order by name`, [agencyId])).rows;
    return {
      canEdit: requirePermBool(p, 'agency.team', agencyId),
      profile: { name: a.name, kind: a.kind, postcode: a.postcode, phone: a.contact_phone, email: a.contact_email ?? a.official_email, status: a.status, pending: a.pending_profile },
      alerts: a.settings.alerts ?? {},
      safetyPlanSigned: !!a.settings.safetyPlanSigned,
      team: AGENCY_TEAM_ROLES.map((r) => ({ role: r, label: ROLE_LABEL[r], n: team.find((t) => t.role === r)?.n ?? 0 })),
      members: members.map((m) => ({ id: m.id, name: m.name, role: m.role, roleLabel: ROLE_LABEL[m.role as Role] ?? m.role, station: m.station })),
      stations,
    };
  }

  async saveSettings(p: Principal, agencyId: string, b: { name?: string; kind?: string; phone?: string; email?: string; alerts?: Record<string, boolean>; safetyPlanSigned?: boolean }) {
    requirePerm(p, 'agency.team', agencyId);
    return this.db.tx(async (c) => {
      const a = (await c.query(`select name, kind, settings from agencies where id = $1 for update`, [agencyId])).rows[0];
      const pending: Record<string, string> = {};
      if (b.name && b.name.trim() !== a.name) pending.name = b.name.trim();
      if (b.kind && b.kind !== a.kind) pending.kind = b.kind;
      const alerts = b.alerts ? { ...(a.settings.alerts ?? {}), ...b.alerts } : a.settings.alerts;
      await c.query(
        `update agencies set contact_phone = coalesce($2, contact_phone), contact_email = coalesce($3, contact_email), settings = settings || $4::jsonb,
                pending_profile = case when $5::jsonb = '{}'::jsonb then pending_profile else coalesce(pending_profile, '{}'::jsonb) || $5::jsonb end where id = $1`,
        [agencyId, b.phone?.trim() || null, b.email?.trim() || null, JSON.stringify({ alerts, ...(b.safetyPlanSigned != null ? { safetyPlanSigned: b.safetyPlanSigned } : {}) }), JSON.stringify(pending)],
      );
      if (Object.keys(pending).length) {
        const admins = (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id);
        await notify(c, admins, { type: 'agency_profile_change', grp: 'account', title: 'Agency asks to change its profile', body: `${a.name}: ${Object.entries(pending).map(([k, v]) => `${k} to "${v}"`).join(', ')}.`, link: '/admin/agencies' });
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.settings', entity: 'agency', entityId: agencyId, payload: { ...b, pending } }, c);
      return { message: Object.keys(pending).length ? 'Saved. The name or type change waits for the platform team to check it.' : 'Saved.' };
    });
  }

  /** "Invite a team member": agency admin, finance, or a station head or dispatcher. */
  async inviteTeam(p: Principal, agencyId: string, b: { name?: string; phone: string; role: (typeof AGENCY_TEAM_ROLES)[number]; stationId?: string }) {
    requirePerm(p, 'agency.team', agencyId);
    return this.db.tx(async (c) => {
      const stationScoped = b.role === 'head' || b.role === 'dispatcher';
      const st = stationScoped ? await this.station(c, agencyId, b.stationId ?? '00000000-0000-0000-0000-000000000000') : null;
      const u = await this.userByPhone(c, b.phone, b.name);
      const scopeType = stationScoped ? 'station' : 'agency';
      const scopeId = stationScoped ? st!.id : agencyId;
      const has = await c.query(`select 1 from user_roles where user_id = $1 and role = $2 and scope_id = $3`, [u.id, b.role, scopeId]);
      if (has.rowCount) throw new AppError(409, 'already_member', 'They already have this role.');
      await c.query(`insert into user_roles (user_id, role, scope_type, scope_id) values ($1, $2, $3, $4)`, [u.id, b.role, scopeType, scopeId]);
      // Staff must use two-step login.
      await c.query(`update users set mfa_enabled = true where id = $1`, [u.id]);
      const where = st ? st.name : 'your agency';
      await notify(c, [u.id], { type: 'team_invite', grp: 'team', title: 'You were given access', body: `${ROLE_LABEL[b.role]} at ${where}.`, link: '/' });
      await this.sms.send({ to: u.phone, body: `You were added as ${ROLE_LABEL[b.role].toLowerCase()} at ${where} on ERP. Sign in to the dashboard with this number.`, urgent: false }).catch(() => undefined);
      await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'team.invite', entity: 'agency', entityId: agencyId, payload: { userId: u.id, role: b.role, scopeId } }, c);
      return { message: `${ROLE_LABEL[b.role]} added. They were sent a text.` };
    });
  }

  async removeTeam(p: Principal, agencyId: string, userId: string, role: string) {
    requirePerm(p, 'agency.team', agencyId);
    if (userId === p.userId && role === 'agency_admin') throw new AppError(422, 'self', 'You cannot remove your own admin access.');
    const r = await this.db.query(
      `delete from user_roles where user_id = $1 and role = $2 and ((scope_type = 'agency' and scope_id = $3) or (scope_type = 'station' and scope_id in (select id from stations where agency_id = $3))) and role <> 'officer'`,
      [userId, role, agencyId],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Not found.');
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'team.remove', entity: 'agency', entityId: agencyId, payload: { userId, role } });
    return { message: 'Access removed.' };
  }

  /** "Download access log": who opened statements and device clips on this agency's reports. */
  async accessLogCsv(p: Principal, agencyId: string) {
    requirePerm(p, 'agency.team', agencyId);
    const r = await this.db.query(
      `select x.at, x.what, x.who, x.item from (
         select a.at, 'Statement ' || a.action as what, coalesce(u.display_name, 'Shared link') as who, s.number as item
           from statement_access a join statements s on s.id = a.statement_id join incidents i on i.id = s.incident_id left join users u on u.id = a.actor_id where i.agency_id = $1
         union all
         select v.at, 'Camera view: ' || v.reason, u.display_name, d.serial
           from camera_access_log v join users u on u.id = v.actor_id join devices d on d.id = v.device_id join incidents i on i.id = v.incident_id where i.agency_id = $1
       ) x order by x.at desc limit 5000`,
      [agencyId],
    );
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'agency.access_log_export', entity: 'agency', entityId: agencyId, payload: { rows: r.rowCount } });
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return ['Time,What,Who,Item', ...r.rows.map((x) => [new Date(x.at).toISOString(), x.what, x.who, x.item].map(q).join(','))].join('\n');
  }

  // ---------------------------------------------------------------- station detail

  async stationDetail(p: Principal, agencyId: string, stationId: string) {
    requirePerm(p, 'agency.operations', agencyId);
    const s = (
      await this.db.query(
        `select s.*, l.postcode, l.address_text, l.area_label, l.lga_id, st_y(coalesce(l.geom::geometry, st_centroid(s.zone::geometry))) as lat, st_x(coalesce(l.geom::geometry, st_centroid(s.zone::geometry))) as lng
           from stations s left join locations l on l.id = s.location_id where s.id = $1 and s.agency_id = $2`,
        [stationId, agencyId],
      )
    ).rows[0];
    if (!s) throw new AppError(404, 'not_found', 'Station not found.');
    const officers = (
      await this.db.query(
        `select o.user_id as id, u.display_name as name, o.on_duty, o.badge_status, (s.head_user_id = o.user_id) as is_head,
                (select i.type || ', ' || coalesce(l.postcode, 'GPS') from incident_units x join incidents i on i.id = x.incident_id left join locations l on l.id = i.location_id
                  where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene') limit 1) as task,
                (select round(avg(rt.stars)::numeric, 1) from ratings rt join incident_units x on x.incident_id = rt.incident_id where x.officer_id = o.user_id) as rating,
                (select min(d.starts_at) from duty_shifts d where d.officer_id = o.user_id and d.starts_at > now() and d.kind in ('day', 'night')) as next_shift
           from officers o join stations s on s.id = o.station_id join users u on u.id = o.user_id where o.station_id = $1 order by is_head desc, o.on_duty desc, u.display_name`,
        [stationId],
      )
    ).rows;
    const live = (
      await this.db.query(
        `select i.id, i.type, i.state, l.postcode, (select u.display_name from incident_units x join users u on u.id = x.officer_id where x.incident_id = i.id and x.state in ('offered', 'accepted', 'en_route', 'on_scene') order by x.offered_at desc limit 1) as officer,
                (select x.offer_expires_at from incident_units x where x.incident_id = i.id and x.state = 'offered' order by x.offered_at desc limit 1) as offer_expires
           from incidents i left join locations l on l.id = i.location_id where i.station_id = $1 and i.state in ${OPEN} order by i.created_at desc limit 10`,
        [stationId],
      )
    ).rows;
    const stats = (
      await this.db.query(
        `select (select avg(extract(epoch from (x.arrived_at - x.accepted_at))) from incident_units x where x.station_id = $1 and x.arrived_at > date_trunc('month', now())) as resp,
                (select round(avg(rt.stars)::numeric, 1) from ratings rt join incidents i on i.id = rt.incident_id where i.station_id = $1) as rating`,
        [stationId],
      )
    ).rows[0];
    const areas = (await this.db.query(`select level, area_id, coalesce(label, area_id) as label from station_areas where station_id = $1 order by level, label`, [stationId])).rows;
    const equipment = (
      await this.db.query(`select i.id, coalesce(i.name, f.label) as name, i.quantity, i.status, i.pilot_name from agency_inventory i join agency_fees f on f.code = i.fee_code where i.station_id = $1 and i.removed_at is null order by 2`, [stationId])
    ).rows;
    const devices = (
      await this.db.query(
        `select d.type, d.status, (select count(*)::int from device_events e where e.device_id = d.id and e.kind = 'tamper' and e.at > now() - interval '1 day') as tampers
           from devices d left join properties pr on pr.id = d.property_id join locations l on l.id = coalesce(d.location_id, pr.location_id)
          where exists (select 1 from station_areas sa where sa.station_id = $1 and ((sa.level = 'area' and sa.area_id = l.area_id) or (sa.level = 'district' and sa.area_id = l.district_id) or (sa.level = 'lga' and sa.area_id = l.lga_id)))`,
        [stationId],
      )
    ).rows;
    const reports = (
      await this.db.query(
        `select i.id, i.type, i.state, i.created_at, i.closed_at, l.postcode from incidents i left join locations l on l.id = i.location_id where i.station_id = $1 order by i.created_at desc limit 30`,
        [stationId],
      )
    ).rows;
    const cams = devices.filter((d) => d.type === 'camera');
    const lights = devices.filter((d) => d.type === 'street_light');
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      phone: s.phone,
      postcode: s.postcode,
      address: s.address_text,
      area: s.area_label,
      lga: s.lga_id,
      center: s.lat != null ? { lat: Number(s.lat), lng: Number(s.lng) } : null,
      stats: { onDuty: officers.filter((o) => o.on_duty).length, officers: officers.length, open: live.length, avgResponseS: stats.resp == null ? null : Math.round(Number(stats.resp)), rating: stats.rating == null ? null : Number(stats.rating) },
      officers: officers.map((o) => ({
        id: o.id,
        name: o.name,
        line: o.is_head ? 'Station head' : o.task ? `On a report, ${cap(o.task)}` : o.on_duty ? (o.rating ? `Rating ${o.rating}` : 'Free') : o.next_shift ? `Shift starts ${new Date(o.next_shift).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No shift booked',
        status: o.badge_status !== 'verified' ? 'invited' : o.task ? 'busy' : o.on_duty ? 'on_duty' : 'off_duty',
      })),
      live: live.map((i) => ({
        id: i.id,
        label: `${cap(i.type)}, ${i.postcode ?? 'GPS'}`,
        state: i.state,
        line: i.officer ? `${i.officer} ${i.state === 'on_scene' ? 'on scene' : i.state === 'en_route' ? 'en route' : i.state === 'offered' ? 'offered' : 'accepted'}` : 'Looking for an officer',
        offerSecondsLeft: i.offer_expires ? Math.max(0, Math.round((+new Date(i.offer_expires) - Date.now()) / 1000)) : null,
      })),
      areas: areas.map((a) => ({ level: a.level, id: a.area_id, label: a.label })),
      equipment: equipment.map((e) => ({ id: e.id, name: e.name, count: e.quantity, status: e.status, statusLabel: EQUIP_STATUS[e.status], pilot: e.pilot_name })),
      devices: {
        cameras: { total: cams.length, online: cams.filter((d) => d.status === 'online').length, faults: cams.filter((d) => ['needs_repair', 'tamper', 'offline'].includes(d.status)).length },
        lights: { total: lights.length, online: lights.filter((d) => d.status === 'online').length, lowPower: lights.filter((d) => d.status === 'low_power').length },
        tamper24h: devices.reduce((a, d) => a + d.tampers, 0) + devices.filter((d) => d.status === 'tamper').length,
      },
      reports: reports.map((i) => ({ id: i.id, label: `${cap(i.type)}, ${i.postcode ?? 'GPS'}`, state: i.state, at: i.created_at, closedAt: i.closed_at })),
    };
  }

  async editStation(p: Principal, agencyId: string, stationId: string, b: { name?: string; phone?: string; status?: 'active' | 'paused' }) {
    requirePerm(p, 'agency.operations', agencyId);
    const r = await this.db.query(
      `update stations set name = coalesce($3, name), phone = coalesce($4, phone), status = case when $5::text is null then status when status in ('active', 'paused') then $5 else status end
        where id = $1 and agency_id = $2 returning id`,
      [stationId, agencyId, b.name?.trim() || null, b.phone?.trim() || null, b.status ?? null],
    );
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Station not found.');
    await this.audit.write({ actorId: p.userId, actorRole: 'agency_admin', action: 'station.edit', entity: 'station', entityId: stationId, payload: b });
    return { message: 'Saved.' };
  }
}

function requirePermBool(p: Principal, perm: 'agency.team', agencyId: string) {
  try {
    requirePerm(p, perm, agencyId);
    return true;
  } catch {
    return false;
  }
}
