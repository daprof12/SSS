// Platform admin operations boards: "Coverage map", "Device wall" (+ camera and street light modal),
// "Inventory", "Agencies and stations" and "Donations and payouts". Every list takes the location
// filter; every view of a camera and every control action is written to the audit log.
import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DONATION_RULES, donationFee, problemLabel, ROLE_LABEL, ROLE_SCOPE_NOTE, type Role } from '@erp/domain';
import { Audit } from '../core/audit';
import { requirePerm, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { coveringStation } from '../core/jurisdiction';
import { stateLabels, type AgencyRow } from '../agencies/agency.lifecycle';
import { locationWhere, type LocationFilter } from '../core/location-filter';
import { notify } from '../reports/shared';

const MONTH = `date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`;
const OPEN = `('received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred', 'on_scene', 'closing')`;
export const STOCK_ITEMS = ['camera', 'street_light', 'gateway', 'drone', 'battery', 'solar_panel', 'pole'] as const;
export type StockItem = (typeof STOCK_ITEMS)[number];
const ITEM_LABEL: Record<StockItem, string> = {
  camera: 'Cameras',
  street_light: 'Street lights',
  gateway: 'Gateways',
  drone: 'Drones',
  battery: 'Batteries',
  solar_panel: 'Solar panels',
  pole: 'Poles',
};
const STATUS_LINE: Record<string, string> = {
  offline: 'Offline',
  low_power: 'Low power',
  needs_repair: 'Needs repair',
  tamper: 'Tamper alert',
  online: 'Online',
};
const KIND: Record<string, string> = { police: 'Police', fire: 'Fire service', health: 'Ambulance and health', frsc: 'Road safety', roads: 'Roads', naptip: 'NAPTIP' };
const SUB_LABEL: Record<string, string> = {
  active: 'Active',
  grace: 'Payment due',
  extras_paused: 'Payment due',
  sharing_paused: 'Payment due',
  switched_off: 'Switched off',
  install_pending: 'Install pending',
  install_booked: 'Install booked',
  paused: 'Paused',
  cancelled: 'Cancelled',
  draft: 'Not started',
};

/** Devices with the place they sit at: their own location, else their household's. */
const DEVICE_FROM = `devices d
  left join properties pr on pr.id = d.property_id
  left join locations l on l.id = coalesce(d.location_id, pr.location_id)
  left join users ow on ow.id = pr.owner_id`;
/** True when some station's areas or zone cover the location aliased `l`. */
const COVERED = `(exists (select 1 from station_areas sa join stations s on s.id = sa.station_id and s.status = 'active'
                   where (sa.level = 'area' and sa.area_id = l.area_id) or (sa.level = 'district' and sa.area_id = l.district_id) or (sa.level = 'lga' and sa.area_id = l.lga_id))
              or exists (select 1 from stations s where s.status = 'active' and st_covers(s.zone, l.geom)))`;

@Injectable()
export class AdminOpsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  // ---------------------------------------------------------------- coverage map

  async coverage(p: Principal, b: { type?: string; status?: string } & LocationFilter) {
    requirePerm(p, 'platform.devices');
    const args: unknown[] = [];
    const where = locationWhere(b, args);
    const rows = (
      await this.db.query(
        `select d.id, d.type, d.status, d.serial, d.name, d.battery_pct, d.last_seen, d.property_id,
                l.postcode, l.area_label, st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lng, ow.display_name as owner,
                ${COVERED} as covered,
                (select number from install_jobs j where j.device_id = d.id and j.kind = 'repair' and j.confirmed_at is null and j.state <> 'cancelled' limit 1) as repair
           from ${DEVICE_FROM}
          where l.id is not null and ${where}
          order by d.created_at`,
        args,
      )
    ).rows;
    const stats = { online: 0, low_power: 0, offline: 0, needs_repair: 0, tamper: 0, notCovered: 0 } as Record<string, number>;
    for (const d of rows) {
      stats[d.status] = (stats[d.status] ?? 0) + 1;
      if (!d.covered) stats.notCovered! += 1;
    }
    const shown = rows.filter((d) => (!b.type || d.type === b.type) && (!b.status || (b.status === 'not_covered' ? !d.covered : d.status === b.status)));
    const SEVERITY: Record<string, number> = { tamper: 0, offline: 1, needs_repair: 2, low_power: 3 };
    const stations = (
      await this.db.query(
        `select s.id, s.name, a.kind, st_y(sl.geom::geometry) as lat, st_x(sl.geom::geometry) as lng
           from stations s join agencies a on a.id = s.agency_id join locations sl on sl.id = s.location_id where s.status = 'active'`,
      )
    ).rows;
    return {
      stats,
      devices: shown.map((d) => this.deviceRow(d)),
      attention: rows
        .filter((d) => d.status in SEVERITY || !d.covered)
        .sort((x, y) => (SEVERITY[x.status] ?? 9) - (SEVERITY[y.status] ?? 9))
        .slice(0, 20)
        .map((d) => ({ ...this.deviceRow(d), why: d.status in SEVERITY ? this.why(d) : 'No station covers this place yet' })),
      stations: stations.map((s) => ({ id: s.id, name: s.name, kind: KIND[s.kind] ?? s.kind, lat: Number(s.lat), lng: Number(s.lng) })),
    };
  }

  private deviceRow(d: Record<string, any>) {
    return {
      id: d.id,
      type: d.type as string,
      status: d.status as string,
      statusLabel: STATUS_LINE[d.status] ?? d.status,
      name: d.name ?? (d.type === 'camera' ? 'Camera' : d.type === 'street_light' ? 'Street light' : d.type),
      serial: d.serial,
      postcode: d.postcode,
      area: d.area_label,
      lat: Number(d.lat),
      lng: Number(d.lng),
      owner: d.owner ?? null,
      householdId: d.property_id ?? null,
      batteryPct: d.battery_pct,
      lastSeen: d.last_seen,
      covered: d.covered as boolean,
      repair: d.repair ?? null,
    };
  }

  private why(d: Record<string, any>) {
    if (d.status === 'tamper') return 'Tamper alert: may have been moved or damaged';
    if (d.status === 'offline') return d.last_seen ? `Offline since ${new Date(d.last_seen).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Never came online';
    if (d.status === 'low_power') return `Low power${d.battery_pct != null ? `, battery ${d.battery_pct}%` : ''}`;
    return 'Needs repair';
  }

  private async deviceAt(c: Queryable, id: string) {
    const d = (
      await c.query(
        `select d.*, l.id as loc_id, l.postcode, l.area_label, l.address_text, ow.display_name as owner, ${COVERED} as covered
           from ${DEVICE_FROM} where d.id = $1`,
        [id],
      )
    ).rows[0];
    if (!d) throw new AppError(404, 'not_found', 'Device not found.');
    return d;
  }

  /** "Send technician": opens a repair ticket the installation team books. */
  async sendTechnician(p: Principal, id: string, note?: string) {
    requirePerm(p, 'platform.devices');
    return this.db.tx(async (c) => {
      const d = await this.deviceAt(c, id);
      if (!d.property_id) throw new AppError(422, 'no_household', 'This device is not linked to a household, so there is no one to book a visit with.');
      const open = (await c.query(`select number from install_jobs where device_id = $1 and kind = 'repair' and confirmed_at is null and state <> 'cancelled' limit 1`, [id])).rows[0];
      if (open) throw new AppError(409, 'repair_open', `A repair for this device is already open: ${open.number}.`);
      const number = await this.repairNumber(c);
      const problem = d.status === 'offline' ? 'offline' : d.status === 'tamper' ? 'damaged' : d.status === 'low_power' ? 'power' : d.type === 'camera' ? 'blurry' : 'light_out';
      const j = await c.query(
        `insert into install_jobs (kind, property_id, number, device_id, problem, description, urgent, reported_by, covered, note)
         values ('repair', $1, $2, $3, $4, $5, $6, $7, true, $8) returning id`,
        [d.property_id, number, id, problem, note?.trim() || `Opened from the coverage map: ${problemLabel(problem)}.`, d.status === 'tamper', p.userId, note?.trim() || null],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'repair.opened', entity: 'device', entityId: id, payload: { number, postcode: d.postcode, jobId: j.rows[0].id } }, c);
      return { number, message: `Repair ticket ${number} opened. The installation team books the visit.` };
    });
  }

  /** "Alert nearest station": the station whose area covers the device, else the nearest. */
  async alertStation(p: Principal, id: string) {
    requirePerm(p, 'platform.devices');
    return this.db.tx(async (c) => {
      const d = await this.deviceAt(c, id);
      if (!d.loc_id) throw new AppError(422, 'no_location', 'This device has no location yet.');
      const s = await coveringStation(c, d.loc_id);
      if (!s) throw new AppError(409, 'no_station', 'No active police station to alert.');
      const heads = (await c.query(`select user_id from user_roles where scope_type = 'station' and scope_id = $1 and role in ('head', 'dispatcher')`, [s.id])).rows.map((x) => x.user_id);
      await notify(c, heads, {
        type: 'device_tamper',
        grp: 'dispatch',
        title: d.status === 'tamper' ? 'Home device may be tampered with' : 'Home device needs a look',
        body: `${d.type === 'camera' ? 'A camera' : 'A street light'} at ${d.postcode ?? 'a home'} shows "${STATUS_LINE[d.status] ?? d.status}". Platform staff asked you to check.`,
        link: '/station/map',
      });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'device.station_alerted', entity: 'device', entityId: id, payload: { stationId: s.id, postcode: d.postcode, inArea: s.inArea } }, c);
      return { message: `${s.name} was alerted${s.inArea ? '' : ' (nearest station; no station covers this area)'}.` };
    });
  }

  private async repairNumber(c: Queryable) {
    for (;;) {
      const n = `RP-${randomInt(100000, 1000000)}`;
      if (!(await c.query(`select 1 from install_jobs where number = $1`, [n])).rowCount) return n;
    }
  }

  // ---------------------------------------------------------------- device wall

  async deviceWall(p: Principal, b: { tab?: string } & LocationFilter) {
    requirePerm(p, 'platform.devices');
    const args: unknown[] = [];
    const where = locationWhere(b, args);
    const tab = b.tab ?? 'all';
    const devs = (
      await this.db.query(
        `select d.id, d.type, d.status, d.serial, d.name, d.battery_pct, d.last_seen, d.property_id, d.lit_hours, d.boost_until,
                l.postcode, l.area_label, st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lng, ow.display_name as owner, true as covered, null as repair
           from ${DEVICE_FROM}
          where d.type in ('camera', 'street_light') and l.id is not null and ${where}
          order by case d.status when 'tamper' then 0 when 'offline' then 1 when 'needs_repair' then 2 when 'low_power' then 3 else 4 end, d.created_at`,
        args,
      )
    ).rows;
    const counts = {
      all: devs.length,
      cameras: devs.filter((d) => d.type === 'camera').length,
      lights: devs.filter((d) => d.type === 'street_light').length,
      offline: devs.filter((d) => d.status === 'offline').length,
      low_power: devs.filter((d) => d.status === 'low_power').length,
      tamper: devs.filter((d) => d.status === 'tamper').length,
    };
    const pick = (d: (typeof devs)[number]) =>
      tab === 'cameras' ? d.type === 'camera' : tab === 'lights' ? d.type === 'street_light' : tab === 'all' ? true : d.status === tab;
    const hargs: unknown[] = [];
    const hwhere = locationWhere(b, hargs);
    const households = (
      await this.db.query(
        `select pr.id, ow.display_name as owner, l.postcode, l.address_text,
                (select count(*)::int from devices d where d.property_id = pr.id) as devices,
                (select count(*)::int from devices d where d.property_id = pr.id and d.status <> 'online') as problems,
                s.state, pl.name as plan, s.next_bill_at,
                (select min(j.scheduled_at) from install_jobs j where j.property_id = pr.id and j.state = 'scheduled' and j.scheduled_at > now()) as next_visit
           from properties pr join locations l on l.id = pr.location_id join users ow on ow.id = pr.owner_id
           left join lateral (select * from subscriptions s where s.property_id = pr.id and s.state <> 'cancelled' order by s.created_at desc limit 1) s on true
           left join plans pl on pl.code = s.plan_code
          where ${hwhere} and (exists (select 1 from devices d where d.property_id = pr.id) or s.id is not null)
          order by problems desc, l.postcode limit 100`,
        hargs,
      )
    ).rows;
    return {
      counts,
      tiles: devs.filter(pick).map((d) => ({ ...this.deviceRow(d), litHours: d.lit_hours == null ? null : Number(d.lit_hours), boosted: !!d.boost_until && new Date(d.boost_until) > new Date() })),
      households: households.map((h) => ({
        id: h.id,
        owner: h.owner,
        postcode: h.postcode,
        address: h.address_text,
        devices: h.devices,
        problems: h.problems,
        plan: h.plan ?? 'No plan',
        state: h.state ?? null,
        stateLabel: h.state ? (SUB_LABEL[h.state] ?? h.state) : 'No plan',
        nextBillAt: h.next_bill_at,
        nextVisit: h.next_visit,
      })),
    };
  }

  /** The camera and street light modal for one household. */
  async household(p: Principal, id: string) {
    requirePerm(p, 'platform.devices');
    const h = (
      await this.db.query(
        `select pr.id, ow.display_name as owner, l.postcode, l.address_text, l.area_label, l.lga_id,
                (select state from subscriptions s where s.property_id = pr.id and s.state <> 'cancelled' order by created_at desc limit 1) as state
           from properties pr join locations l on l.id = pr.location_id join users ow on ow.id = pr.owner_id where pr.id = $1`,
        [id],
      )
    ).rows[0];
    if (!h) throw new AppError(404, 'not_found', 'Household not found.');
    const devices = (
      await this.db.query(
        `select d.*, (select count(*)::int from camera_access_log v where v.device_id = d.id and v.at > now() - interval '30 days') as views
           from devices d where d.property_id = $1 order by d.type, d.created_at`,
        [id],
      )
    ).rows;
    return {
      id: h.id,
      owner: h.owner,
      postcode: h.postcode,
      address: h.address_text,
      area: h.area_label,
      lga: h.lga_id,
      subscription: h.state ? (SUB_LABEL[h.state] ?? h.state) : 'No plan',
      devices: devices.map((d) => ({
        id: d.id,
        type: d.type,
        name: d.name ?? (d.type === 'camera' ? 'Camera' : 'Street light'),
        serial: d.serial,
        status: d.status,
        statusLabel: STATUS_LINE[d.status] ?? d.status,
        lastSeen: d.last_seen,
        batteryPct: d.battery_pct,
        litHours: d.lit_hours == null ? null : Number(d.lit_hours),
        boosted: !!d.boost_until && new Date(d.boost_until) > new Date(),
        lastMotionAt: d.last_motion_at,
        views30d: d.views,
        recordingDays: d.settings?.recordingDays ?? 7,
      })),
    };
  }

  /** Platform staff live view: a reason is required; it is logged with their name and the owner sees it. */
  async liveView(p: Principal, id: string, reason: string) {
    requirePerm(p, 'platform.devices.live_view');
    if (reason.trim().length < 3) throw new AppError(422, 'validation_failed', 'A reason is required. It is logged with your name.', { fields: [{ field: 'reason', message: 'A reason is required. It is logged with your name.' }] });
    return this.db.tx(async (c) => {
      const d = await this.deviceAt(c, id);
      if (d.type !== 'camera') throw new AppError(422, 'not_camera', 'Only cameras have a live view.');
      if (d.status === 'offline') throw new AppError(409, 'offline', 'The camera is offline.');
      await c.query(`insert into camera_access_log (device_id, actor_id, actor_role, reason, via) values ($1, $2, 'platform_admin', $3, 'dashboard')`, [id, p.userId, reason.trim()]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'device.live_view', entity: 'device', entityId: id, reason: reason.trim(), payload: { postcode: d.postcode, propertyId: d.property_id } }, c);
      return d.stream_url
        ? { mode: 'stream' as const, url: d.stream_url as string, expiresInSeconds: 300 }
        : { mode: 'test' as const, note: 'No video provider is connected in this build, so this is a test feed.', expiresInSeconds: 300 };
    });
  }

  /** Street light: "Turn on now" (one hour) or "Flash test". Both logged. */
  async light(p: Principal, id: string, action: 'on' | 'flash') {
    requirePerm(p, 'platform.devices');
    return this.db.tx(async (c) => {
      const d = await this.deviceAt(c, id);
      if (d.type !== 'street_light') throw new AppError(422, 'not_light', 'Only street lights can do this.');
      if (d.status === 'offline') throw new AppError(409, 'offline', 'The light is not responding. Open a repair ticket.');
      if (action === 'on') await c.query(`update devices set boost_until = now() + interval '1 hour' where id = $1`, [id]);
      await c.query(`insert into device_events (device_id, kind, payload) values ($1, $2, $3)`, [id, action === 'on' ? 'boost' : 'flash_test', { by: p.userId, staff: true }]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: action === 'on' ? 'device.light_on' : 'device.flash_test', entity: 'device', entityId: id, payload: { postcode: d.postcode } }, c);
      return { message: action === 'on' ? 'On for the next hour.' : 'Flash test sent. Watch for three flashes.' };
    });
  }

  /** "Schedule visit" for a household: a booked field visit the installation team sees. */
  async scheduleVisit(p: Principal, propertyId: string, b: { date: string; window: 'morning' | 'afternoon'; note?: string }) {
    requirePerm(p, 'platform.devices');
    const at = new Date(`${b.date}T${b.window === 'morning' ? '09:00' : '13:00'}:00+01:00`);
    if (Number.isNaN(+at) || at < new Date()) throw new AppError(422, 'validation_failed', 'Choose a day from tomorrow.', { fields: [{ field: 'date', message: 'Choose a day from tomorrow.' }] });
    return this.db.tx(async (c) => {
      const h = (await c.query(`select pr.id, pr.owner_id, l.postcode from properties pr join locations l on l.id = pr.location_id where pr.id = $1`, [propertyId])).rows[0];
      if (!h) throw new AppError(404, 'not_found', 'Household not found.');
      const device = (await c.query(`select id, status, type from devices where property_id = $1 order by (status = 'online'), created_at limit 1`, [propertyId])).rows[0];
      const number = await this.repairNumber(c);
      const win = b.window === 'morning' ? '9am to 12pm' : '1pm to 5pm';
      await c.query(
        `insert into install_jobs (kind, property_id, number, device_id, problem, description, reported_by, covered, state, scheduled_at, booked_at, visit_window, note)
         values ('repair', $1, $2, $3, $4, $5, $6, true, 'scheduled', $7, now(), $8, $9)`,
        [propertyId, number, device?.id ?? null, device ? (device.status === 'offline' ? 'offline' : device.type === 'camera' ? 'blurry' : 'light_out') : null, b.note?.trim() || 'Check visit booked by platform staff.', p.userId, at, win, b.note?.trim() || null],
      );
      const day = at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' });
      await notify(c, [h.owner_id], { type: 'visit_booked', grp: 'account', title: 'Technician visit booked', body: `A technician will visit on ${day}, ${win}. ${number}.`, link: `/profile/home/repairs/${number}` });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'repair.visit_booked', entity: 'property', entityId: propertyId, payload: { number, at, postcode: h.postcode } }, c);
      return { number, message: `Visit booked for ${day}, ${win}. The owner was told.` };
    });
  }

  // ---------------------------------------------------------------- inventory

  async inventory(p: Principal, f: LocationFilter) {
    requirePerm(p, 'platform.devices');
    const args: unknown[] = [];
    const where = locationWhere(f, args);
    const stores = (
      await this.db.query(
        `select st.id, st.name, l.postcode, l.area_label,
                coalesce(jsonb_object_agg(k.item, jsonb_build_object('quantity', k.quantity, 'reorderAt', k.reorder_at)) filter (where k.item is not null), '{}') as stock
           from stores st left join locations l on l.id = st.location_id left join store_stock k on k.store_id = st.id
          where ${where} group by st.id, l.postcode, l.area_label order by st.name`,
        args,
      )
    ).rows;
    let units = 0;
    const low: { store: string; item: string; quantity: number }[] = [];
    for (const s of stores) {
      for (const [item, v] of Object.entries(s.stock as Record<string, { quantity: number; reorderAt: number }>)) {
        units += v.quantity;
        if (v.quantity <= v.reorderAt) low.push({ store: s.name, item: ITEM_LABEL[item as StockItem] ?? item, quantity: v.quantity });
      }
    }
    const dargs: unknown[] = [];
    const dwhere = locationWhere(f, dargs);
    const devices = (
      await this.db.query(
        `select count(*) filter (where d.created_at >= ${MONTH})::int as installed, count(*) filter (where d.status in ('needs_repair', 'tamper'))::int as repair
           from ${DEVICE_FROM} where ${dwhere}`,
        dargs,
      )
    ).rows[0];
    const moves = (
      await this.db.query(
        `select m.id, m.item, m.quantity, m.note, m.at, f.name as from_store, t.name as to_store, u.display_name as by
           from stock_moves m left join stores f on f.id = m.from_store left join stores t on t.id = m.to_store join users u on u.id = m.actor_id
          order by m.at desc limit 15`,
      )
    ).rows;
    return {
      items: STOCK_ITEMS.map((k) => ({ code: k, label: ITEM_LABEL[k] })),
      stats: { inStock: units, lowStock: low.length, installedThisMonth: devices.installed, inRepair: devices.repair },
      low,
      stores: stores.map((s) => ({ id: s.id, name: s.name, postcode: s.postcode, area: s.area_label, stock: s.stock })),
      moves: moves.map((m) => ({ id: m.id, item: ITEM_LABEL[m.item as StockItem] ?? m.item, quantity: m.quantity, from: m.from_store, to: m.to_store, note: m.note, by: m.by, at: m.at })),
    };
  }

  async addStock(p: Principal, b: { storeId: string; item: StockItem; quantity: number; note?: string }) {
    requirePerm(p, 'platform.devices');
    return this.db.tx(async (c) => {
      const s = (await c.query(`select name from stores where id = $1`, [b.storeId])).rows[0];
      if (!s) throw new AppError(404, 'not_found', 'Store not found.');
      await c.query(`insert into store_stock (store_id, item, quantity) values ($1, $2, $3) on conflict (store_id, item) do update set quantity = store_stock.quantity + excluded.quantity`, [b.storeId, b.item, b.quantity]);
      await c.query(`insert into stock_moves (item, quantity, to_store, note, actor_id) values ($1, $2, $3, $4, $5)`, [b.item, b.quantity, b.storeId, b.note?.trim() || 'Received', p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'stock.added', entity: 'store', entityId: b.storeId, payload: { item: b.item, quantity: b.quantity } }, c);
      return { message: `Added ${b.quantity} ${ITEM_LABEL[b.item].toLowerCase()} to ${s.name}.` };
    });
  }

  async transferStock(p: Principal, b: { from: string; to: string; item: StockItem; quantity: number; note?: string }) {
    requirePerm(p, 'platform.devices');
    if (b.from === b.to) throw new AppError(422, 'validation_failed', 'Choose two different stores.', { fields: [{ field: 'to', message: 'Choose a different store.' }] });
    return this.db.tx(async (c) => {
      const names = (await c.query(`select id, name from stores where id = any($1::uuid[])`, [[b.from, b.to]])).rows;
      if (names.length !== 2) throw new AppError(404, 'not_found', 'Store not found.');
      const r = await c.query(`update store_stock set quantity = quantity - $3 where store_id = $1 and item = $2 and quantity >= $3 returning quantity`, [b.from, b.item, b.quantity]);
      if (!r.rowCount) {
        const have = (await c.query(`select quantity from store_stock where store_id = $1 and item = $2`, [b.from, b.item])).rows[0]?.quantity ?? 0;
        throw new AppError(409, 'not_enough', `Only ${have} in that store.`, { fields: [{ field: 'quantity', message: `Only ${have} in that store.` }] });
      }
      await c.query(`insert into store_stock (store_id, item, quantity) values ($1, $2, $3) on conflict (store_id, item) do update set quantity = store_stock.quantity + excluded.quantity`, [b.to, b.item, b.quantity]);
      await c.query(`insert into stock_moves (item, quantity, from_store, to_store, note, actor_id) values ($1, $2, $3, $4, $5, $6)`, [b.item, b.quantity, b.from, b.to, b.note?.trim() || null, p.userId]);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'stock.transferred', entity: 'store', entityId: b.from, payload: { to: b.to, item: b.item, quantity: b.quantity } }, c);
      const to = names.find((x) => x.id === b.to)!.name;
      return { message: `Moved ${b.quantity} ${ITEM_LABEL[b.item].toLowerCase()} to ${to}.` };
    });
  }

  // ---------------------------------------------------------------- agencies and stations

  async agencies(p: Principal, b: { kind?: string } & LocationFilter) {
    requirePerm(p, 'platform.agencies');
    const aargs: unknown[] = [b.kind ?? null];
    const awhere = locationWhere(b, aargs);
    const agencies = (
      await this.db.query(
        `select a.id, a.name, a.kind, a.status, a.submitted_at, l.postcode,
                (select count(*)::int from stations s where s.agency_id = a.id) as stations,
                (select count(*)::int from officers o join stations s on s.id = o.station_id where s.agency_id = a.id) as officers,
                (select count(*)::int from incidents i where i.agency_id = a.id and i.state in ${OPEN}) as open
           from agencies a left join locations l on l.id = a.location_id
          where ($1::text is null or a.kind = $1) and ${awhere}
          order by case when a.status in ('documents_submitted', 'in_review') then 0 else 1 end, a.name`,
        aargs,
      )
    ).rows;
    const sargs: unknown[] = [b.kind ?? null];
    const swhere = locationWhere(b, sargs);
    const stations = (
      await this.db.query(
        `select s.id, s.name, s.status, a.name as agency, a.kind, l.postcode,
                coalesce((select string_agg(coalesce(sa.label, sa.area_id), ', ' order by sa.level) from station_areas sa where sa.station_id = s.id), '') as areas,
                (select count(*)::int from officers o where o.station_id = s.id) as officers,
                (select count(*)::int from officers o where o.station_id = s.id and o.on_duty) as on_duty,
                (select count(*)::int from incidents i where i.station_id = s.id and i.state in ${OPEN}) as open
           from stations s join agencies a on a.id = s.agency_id left join locations l on l.id = s.location_id
          where ($1::text is null or a.kind = $1) and ${swhere}
          order by a.name, s.name`,
        sargs,
      )
    ).rows;
    return {
      kinds: Object.entries(KIND).map(([code, label]) => ({ code, label })),
      stats: {
        live: agencies.filter((a) => a.status === 'live').length,
        waiting: agencies.filter((a) => ['documents_submitted', 'in_review'].includes(a.status)).length,
        stations: stations.filter((s) => s.status === 'active').length,
        noArea: stations.filter((s) => s.status === 'active' && !s.areas).length,
      },
      agencies: agencies.map((a) => ({
        id: a.id,
        name: a.name,
        kind: KIND[a.kind] ?? a.kind,
        status: a.status,
        statusLabel: stateLabels[a.status as AgencyRow['status']] ?? a.status,
        waiting: ['documents_submitted', 'in_review'].includes(a.status),
        postcode: a.postcode,
        stations: a.stations,
        officers: a.officers,
        open: a.open,
        submittedAt: a.submitted_at,
      })),
      stations: stations.map((s) => ({
        id: s.id,
        name: s.name,
        agency: s.agency,
        kind: KIND[s.kind] ?? s.kind,
        status: s.status,
        postcode: s.postcode,
        areas: s.areas || null,
        officers: s.officers,
        onDuty: s.on_duty,
        open: s.open,
      })),
    };
  }

  // ---------------------------------------------------------------- donations and payouts

  /** Location of the receiving station: the station itself, an officer's station, or the agency's address. */
  async donations(p: Principal, f: LocationFilter) {
    requirePerm(p, 'platform.money');
    const args: unknown[] = [];
    const where = locationWhere(f, args);
    const base = `from donations d
      left join stations st on (d.target_type = 'station' and st.id = d.target_id) or (d.target_type = 'officer' and st.id = (select station_id from officers where user_id = d.target_id))
      left join agencies ag on ag.id = coalesce(case when d.target_type = 'agency' then d.target_id end, st.agency_id)
      left join locations l on l.id = coalesce(st.location_id, ag.location_id)
      where d.state = 'paid' and ${where}`;
    const s = (
      await this.db.query(
        `select coalesce(sum(d.amount_kobo) filter (where d.paid_at >= ${MONTH}), 0)::bigint as month,
                coalesce(sum(d.amount_kobo) filter (where d.payout_state = 'queued'), 0)::bigint as waiting,
                coalesce(sum(d.amount_kobo) filter (where d.payout_state = 'paid' and d.paid_out_at >= ${MONTH}), 0)::bigint as paid
           ${base}`,
        args,
      )
    ).rows[0];
    const net = (k: number) => k - donationFee(k);
    const list = (
      await this.db.query(
        `select d.id, d.amount_kobo, d.target_type, d.show_name, d.payout_state, d.payout_failure, d.paid_at, d.method,
                du.display_name as donor, coalesce(case d.target_type when 'officer' then ou.display_name when 'station' then st.name else ag.name end, '—') as recipient
           ${base.replace('where d.state', 'left join users du on du.id = d.donor_id left join users ou on d.target_type = \'officer\' and ou.id = d.target_id where d.state')}
          order by d.paid_at desc nulls last limit 50`,
        args,
      )
    ).rows;
    const tue = new Date();
    tue.setDate(tue.getDate() + ((9 - tue.getDay()) % 7 || 7));
    return {
      stats: { donatedMonthKobo: Number(s.month), waitingKobo: net(Number(s.waiting)), paidOutMonthKobo: net(Number(s.paid)), feePct: DONATION_RULES.platformFeePct, nextRun: tue.toISOString().slice(0, 10) },
      donations: list.map((d) => ({
        id: d.id,
        donor: d.show_name ? d.donor : 'Anonymous',
        recipient: d.recipient,
        level: d.target_type[0].toUpperCase() + d.target_type.slice(1),
        amountKobo: Number(d.amount_kobo),
        netKobo: net(Number(d.amount_kobo)),
        paidVia: d.method === 'wallet' ? 'Wallet' : 'Paystack',
        payout: d.payout_state,
        failure: d.payout_failure,
        at: d.paid_at,
      })),
    };
  }

  /** "Run payout": queued gifts go to their recipients' wallets now (the weekly run does the same). */
  async runDonationPayout(p: Principal) {
    requirePerm(p, 'platform.money');
    return this.db.tx(async (c) => {
      const r = await c.query(`update donations set payout_state = 'paid', paid_out_at = now() where state = 'paid' and payout_state in ('queued', 'failed') returning amount_kobo`);
      const total = r.rows.reduce((a, x) => a + Number(x.amount_kobo), 0);
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'donation.payout_run', entity: 'donations', payload: { count: r.rowCount, grossKobo: total } }, c);
      return { count: r.rowCount ?? 0, message: r.rowCount ? `Paid out ${r.rowCount} ${r.rowCount === 1 ? 'gift' : 'gifts'}.` : 'Nothing is waiting for payout.' };
    });
  }

  // ---------------------------------------------------------------- platform team (role-based access)

  async team(p: Principal) {
    requirePerm(p, 'platform.team');
    const r = await this.db.query(
      `select u.id, u.display_name as name, u.phone, ur.role, ur.created_at from user_roles ur join users u on u.id = ur.user_id
        where ur.role = any($1::text[]) order by ur.role, u.display_name`,
      [PLATFORM_ROLES],
    );
    return {
      roles: PLATFORM_ROLES.map((role) => ({ role, label: ROLE_LABEL[role], note: ROLE_SCOPE_NOTE[role] ?? '', n: r.rows.filter((x) => x.role === role).length })),
      members: r.rows.map((x) => ({ id: x.id, name: x.name, phone: x.phone ? `•••• ${String(x.phone).slice(-4)}` : null, role: x.role, roleLabel: ROLE_LABEL[x.role as Role], isMe: x.id === p.userId })),
    };
  }

  async inviteStaff(p: Principal, b: { phone: string; name?: string; role: (typeof PLATFORM_ROLES)[number] }) {
    requirePerm(p, 'platform.team');
    return this.db.tx(async (c) => {
      const phone = b.phone.replace(/\s+/g, '');
      if (!/^\+234\d{10}$/.test(phone)) throw new AppError(422, 'validation_failed', 'Enter a Nigerian phone number.', { fields: [{ field: 'phone', message: 'Enter a Nigerian phone number.' }] });
      let u = (await c.query(`select id from users where phone = $1`, [phone])).rows[0]?.id as string | undefined;
      if (!u) {
        if (!b.name?.trim()) throw new AppError(422, 'validation_failed', 'Enter their full name.', { fields: [{ field: 'name', message: 'Enter their full name.' }] });
        u = (await c.query(`insert into users (phone, display_name) values ($1, $2) returning id`, [phone, b.name.trim()])).rows[0].id as string;
      }
      if ((await c.query(`select 1 from user_roles where user_id = $1 and role = $2`, [u, b.role])).rowCount) throw new AppError(409, 'already_member', 'They already have this role.');
      await c.query(`insert into user_roles (user_id, role, scope_type) values ($1, $2, 'platform')`, [u, b.role]);
      await c.query(`update users set mfa_enabled = true where id = $1`, [u]);
      await notify(c, [u], { type: 'team_invite', grp: 'team', title: 'You were given platform access', body: `${ROLE_LABEL[b.role]}: ${ROLE_SCOPE_NOTE[b.role] ?? ''}`, link: '/' });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'team.invite', entity: 'user', entityId: u, payload: { role: b.role } }, c);
      return { message: `${ROLE_LABEL[b.role]} added. They sign in to the dashboard with their phone.` };
    });
  }

  async removeStaff(p: Principal, userId: string, role: string) {
    requirePerm(p, 'platform.team');
    if (!(PLATFORM_ROLES as readonly string[]).includes(role)) throw new AppError(422, 'validation_failed', 'Not a platform role.');
    if (userId === p.userId && role === 'platform_admin') throw new AppError(422, 'self', 'You cannot remove your own admin access.');
    if (role === 'platform_admin') {
      const n = (await this.db.query(`select count(*)::int as n from user_roles where role = 'platform_admin'`)).rows[0].n;
      if (n <= 1) throw new AppError(422, 'last_admin', 'There must always be one platform admin.');
    }
    const r = await this.db.query(`delete from user_roles where user_id = $1 and role = $2`, [userId, role]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Not found.');
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'team.remove', entity: 'user', entityId: userId, payload: { role } });
    return { message: 'Access removed.' };
  }
}

export const PLATFORM_ROLES = ['platform_admin', 'platform_finance', 'platform_support', 'platform_ops'] as const;
