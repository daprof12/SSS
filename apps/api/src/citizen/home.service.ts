// Home: household members (B4 step 8), devices and camera access (B6), device fault → repair (B5).
// Boards: Household invite, My home devices, Camera view, Camera offline, Street light view,
// Report a device problem, Repair status.
import { checkRepairReport, DEVICE_RULES, HOUSEHOLD_RULES, problemLabel, repairStep } from '@erp/domain';
import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { SMS, type SmsAdapter } from '../adapters/sms';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';

interface Home {
  propertyId: string;
  ownerId: string;
  role: 'owner' | 'member';
  canViewLive: boolean;
  canGetAlerts: boolean;
  canReport: boolean;
  locationId: string;
}

const PLAN_STATE: Record<string, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'success' },
  grace: { label: 'Payment due', tone: 'warning' },
  extras_paused: { label: 'Extras paused', tone: 'warning' },
  sharing_paused: { label: 'Sharing paused', tone: 'warning' },
  switched_off: { label: 'Switched off', tone: 'critical' },
  paused: { label: 'Paused', tone: 'neutral' },
  install_pending: { label: 'Install pending', tone: 'info' },
  install_booked: { label: 'Install booked', tone: 'info' },
};
const day = (d: Date | string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const hm = (d: Date | string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
function ago(d: Date | string | null): string {
  if (!d) return 'never';
  const m = Math.max(0, Math.round((Date.now() - +new Date(d)) / 60000));
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ${h === 1 ? 'hour' : 'hours'} ago` : `${Math.round(h / 24)} days ago`;
}
const normalPhone = (p: string) => {
  const d = p.replace(/[^\d+]/g, '');
  return d.startsWith('0') ? `+234${d.slice(1)}` : d;
};

@Injectable()
export class HomeService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(SMS) private readonly sms: SmsAdapter,
  ) {}

  /** The home this person owns, or the one they are a member of. */
  private async home(userId: string, c: Queryable = this.db.pool): Promise<Home | null> {
    const own = (await c.query(`select id, owner_id, location_id from properties where owner_id = $1 order by created_at limit 1`, [userId])).rows[0];
    if (own) return { propertyId: own.id, ownerId: own.owner_id, role: 'owner', canViewLive: true, canGetAlerts: true, canReport: true, locationId: own.location_id };
    const m = (
      await c.query(
        `select p.id, p.owner_id, p.location_id, m.can_view_live, m.can_get_alerts, m.can_report from property_members m join properties p on p.id = m.property_id where m.user_id = $1 limit 1`,
        [userId],
      )
    ).rows[0];
    return m ? { propertyId: m.id, ownerId: m.owner_id, role: 'member', canViewLive: m.can_view_live, canGetAlerts: m.can_get_alerts, canReport: m.can_report, locationId: m.location_id } : null;
  }

  private async mustHome(p: Principal) {
    const h = await this.home(p.userId);
    if (!h) throw new AppError(404, 'no_home', 'You have no home with devices yet.');
    return h;
  }

  private deviceLine(d: Record<string, any>): string {
    if (d.status === 'offline') return `Last seen ${ago(d.last_seen)}`;
    if (d.type === 'street_light') {
      if (d.boost_until && new Date(d.boost_until) > new Date()) return `On for you until ${hm(d.boost_until)}`;
      return d.status === 'low_power' ? `Battery ${d.battery_pct ?? '?'}%` : 'On, dusk to dawn';
    }
    if (d.status === 'tamper') return 'Possible tampering reported';
    if (d.status === 'needs_repair') return 'Repair booked';
    return `Seen ${ago(d.last_seen)}`;
  }

  async overview(p: Principal) {
    const h = await this.home(p.userId);
    const incoming = await this.incoming(p);
    if (!h) return { home: null, incoming };
    const place = (await this.db.query(`select postcode, address_text, area_label from locations where id = $1`, [h.locationId])).rows[0];
    const sub = (
      await this.db.query(
        `select s.state, s.next_bill_at, pl.name from subscriptions s join plans pl on pl.code = s.plan_code where s.property_id = $1 and s.state <> 'cancelled' order by s.created_at desc limit 1`,
        [h.propertyId],
      )
    ).rows[0];
    const devices = await this.db.query(`select * from devices where property_id = $1 and type in ('camera', 'street_light') order by type, created_at, id`, [h.propertyId]);
    const repairs = await this.db.query(
      `select j.id, j.number, j.problem, j.state, j.fault_confirmed_at, j.booked_at, j.fixed_at, j.confirmed_at, d.name as device
         from install_jobs j left join devices d on d.id = j.device_id
        where j.property_id = $1 and j.kind = 'repair' and j.confirmed_at is null and j.state <> 'cancelled' order by j.created_at desc`,
      [h.propertyId],
    );
    const offline = devices.rows.find((d) => d.status === 'offline' && d.type === 'camera') ?? devices.rows.find((d) => d.status === 'offline');
    const low = devices.rows.find((d) => d.status === 'low_power');
    return {
      home: {
        role: h.role,
        address: place?.address_text ?? '',
        postcode: place?.postcode ?? '',
        area: place?.area_label ?? '',
        plan: sub ? { name: sub.name, state: sub.state, label: PLAN_STATE[sub.state]?.label ?? sub.state, tone: PLAN_STATE[sub.state]?.tone ?? 'neutral', paidUntil: sub.next_bill_at } : null,
        permissions: { viewLive: h.canViewLive, alerts: h.canGetAlerts, report: h.canReport },
      },
      devices: devices.rows.map((d) => ({
        id: d.id,
        type: d.type,
        name: d.name ?? (d.type === 'camera' ? 'Camera' : 'Street light'),
        status: d.status,
        line: this.deviceLine(d),
        batteryPct: d.battery_pct,
      })),
      alert: offline
        ? { deviceId: offline.id, tone: 'warning', title: `${offline.name ?? 'A device'} is offline`, line: 'Tap to see what to try or report a problem.' }
        : low
          ? { deviceId: low.id, tone: 'warning', title: `${low.name ?? 'A street light'} is low on power`, line: 'It may go dark early. Report it so the team can check it.' }
          : null,
      repairs: repairs.rows.map((r) => ({ id: r.id, number: r.number, device: r.device, problem: problemLabel(r.problem ?? ''), step: repairStep({ faultConfirmedAt: r.fault_confirmed_at, bookedAt: r.booked_at, fixedAt: r.fixed_at, confirmedAt: r.confirmed_at, state: r.state }) })),
      incoming,
    };
  }

  // ---------------------------------------------------------------- household (board "Household invite")

  async household(p: Principal) {
    const h = await this.mustHome(p);
    const members = await this.db.query(
      `select u.id, u.display_name, m.can_view_live, m.can_get_alerts, m.can_report from property_members m join users u on u.id = m.user_id where m.property_id = $1 order by m.created_at`,
      [h.propertyId],
    );
    const owner = (await this.db.query(`select id, display_name from users where id = $1`, [h.ownerId])).rows[0];
    const invites = h.role === 'owner' ? await this.db.query(`select id, phone, can_view_live, can_get_alerts, can_report, created_at from property_invites where property_id = $1 and state = 'sent' order by created_at`, [h.propertyId]) : { rows: [] };
    return {
      role: h.role,
      maxMembers: HOUSEHOLD_RULES.maxMembers,
      people: [
        { id: owner.id, name: owner.id === p.userId ? 'You' : owner.display_name, role: 'owner', you: owner.id === p.userId },
        ...members.rows.map((m) => ({
          id: m.id,
          name: m.id === p.userId ? 'You' : m.display_name,
          role: 'member',
          you: m.id === p.userId,
          can: { viewLive: m.can_view_live, alerts: m.can_get_alerts, report: m.can_report },
        })),
        ...invites.rows.map((i) => ({ id: i.id, name: i.phone, role: 'invited', you: false, can: { viewLive: i.can_view_live, alerts: i.can_get_alerts, report: i.can_report } })),
      ],
    };
  }

  async invite(p: Principal, b: { phone: string; viewLive: boolean; alerts: boolean; report: boolean }) {
    const h = await this.mustHome(p);
    if (h.role !== 'owner') throw new AppError(403, 'owner_only', 'Only the home owner can invite people.');
    const phone = normalPhone(b.phone);
    const fail = (message: string, code = 'validation_failed') => new AppError(422, code, message, { fields: [{ field: 'phone', message }] });
    if (!/^\+234\d{10}$/.test(phone)) throw fail('Enter a Nigerian phone number.');
    return this.db.tx(async (c) => {
      const me = (await c.query(`select phone from users where id = $1`, [p.userId])).rows[0];
      if (me.phone === phone) throw fail('That is your own number.');
      const count = (await c.query(`select (select count(*) from property_members where property_id = $1) + (select count(*) from property_invites where property_id = $1 and state = 'sent') as n`, [h.propertyId])).rows[0].n;
      if (Number(count) + 1 >= HOUSEHOLD_RULES.maxMembers) throw fail(`A home can have up to ${HOUSEHOLD_RULES.maxMembers} people.`, 'household_full');
      const user = (await c.query(`select id, display_name from users where phone = $1`, [phone])).rows[0];
      if (user) {
        const elsewhere = await c.query(`select 1 from property_members where user_id = $1 union all select 1 from properties where owner_id = $1`, [user.id]);
        if (elsewhere.rowCount) throw fail(`${user.display_name} is already in a household.`, 'already_in_household');
      }
      const dup = await c.query(`select 1 from property_invites where property_id = $1 and phone = $2 and state = 'sent'`, [h.propertyId, phone]);
      if (dup.rowCount) throw fail('You already invited this number. They can accept it in the app.', 'already_invited');
      const inv = await c.query(
        `insert into property_invites (property_id, phone, invitee_id, can_view_live, can_get_alerts, can_report, invited_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [h.propertyId, phone, user?.id ?? null, b.viewLive, b.alerts, b.report, p.userId],
      );
      const from = (await c.query(`select display_name from users where id = $1`, [p.userId])).rows[0].display_name;
      if (user) {
        await notify(c, [user.id], { type: 'household_invite', grp: 'account', title: 'Home invite', body: `${from} invited you to join their home. Accept to see what they allowed.`, link: '/profile/home' });
      } else {
        await this.sms.send({ to: phone, urgent: false, body: `${from} invited you to join their home on ERP. Get the app and sign in with this number to accept.` });
      }
      await this.audit.write({ actorId: p.userId, action: 'household.invite', entity: 'property', entityId: h.propertyId, payload: { phone: `${phone.slice(0, 7)}•••` } }, c);
      return { id: inv.rows[0].id, message: user ? `Invite sent to ${user.display_name}.` : 'Invite sent by text message.' };
    });
  }

  async revokeInvite(p: Principal, id: string) {
    const h = await this.mustHome(p);
    if (h.role !== 'owner') throw new AppError(403, 'owner_only', 'Only the home owner can do this.');
    const r = await this.db.query(`update property_invites set state = 'revoked', decided_at = now() where id = $1 and property_id = $2 and state = 'sent'`, [id, h.propertyId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Invite not found.');
    return { message: 'Invite cancelled.' };
  }

  /** The owner removes a member, or a member leaves. */
  async removeMember(p: Principal, userId: string) {
    const h = await this.mustHome(p);
    if (h.role !== 'owner' && userId !== p.userId) throw new AppError(403, 'owner_only', 'Only the home owner can remove people.');
    const r = await this.db.query(`delete from property_members where property_id = $1 and user_id = $2`, [h.propertyId, userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Member not found.');
    await this.audit.write({ actorId: p.userId, action: userId === p.userId ? 'household.leave' : 'household.remove', entity: 'property', entityId: h.propertyId, payload: { userId } });
    return { message: userId === p.userId ? 'You left the home.' : 'Removed from your home.' };
  }

  async incoming(p: Principal) {
    const r = await this.db.query(
      `select i.id, u.display_name as from_name, l.address_text, i.can_view_live, i.can_get_alerts, i.can_report
         from property_invites i join users me on me.id = $1 and me.phone = i.phone
         join properties pr on pr.id = i.property_id join users u on u.id = pr.owner_id join locations l on l.id = pr.location_id
        where i.state = 'sent' order by i.created_at desc`,
      [p.userId],
    );
    return r.rows.map((i) => ({ id: i.id, from: i.from_name, address: i.address_text, can: { viewLive: i.can_view_live, alerts: i.can_get_alerts, report: i.can_report } }));
  }

  async answer(p: Principal, id: string, accept: boolean) {
    return this.db.tx(async (c) => {
      const i = (await c.query(`select i.* from property_invites i join users me on me.id = $2 and me.phone = i.phone where i.id = $1 and i.state = 'sent' for update of i`, [id, p.userId])).rows[0];
      if (!i) throw new AppError(404, 'not_found', 'This invite is no longer open.');
      if (accept) {
        if (await this.home(p.userId, c)) throw new AppError(409, 'already_in_household', 'You are already in a household. Leave it first.');
        await c.query(
          `insert into property_members (property_id, user_id, relation, can_view_live, can_get_alerts, can_report) values ($1, $2, 'member', $3, $4, $5)`,
          [i.property_id, p.userId, i.can_view_live, i.can_get_alerts, i.can_report],
        );
      }
      await c.query(`update property_invites set state = $2, invitee_id = $3, decided_at = now() where id = $1`, [id, accept ? 'active' : 'declined', p.userId]);
      const me = (await c.query(`select display_name from users where id = $1`, [p.userId])).rows[0].display_name;
      await notify(c, [i.invited_by], {
        type: accept ? 'household_joined' : 'household_declined',
        grp: 'account',
        title: accept ? 'Joined your home' : 'Invite declined',
        body: accept ? `${me} joined your home.` : `${me} declined your invite.`,
        link: '/profile/home/household',
      });
      return { message: accept ? 'You joined the home.' : 'Invite declined.' };
    });
  }

  // ---------------------------------------------------------------- devices (boards "Camera view", "Camera offline", "Street light view")

  private async device(p: Principal, id: string) {
    const h = await this.mustHome(p);
    const d = (await this.db.query(`select d.*, l.postcode, l.address_text from devices d left join locations l on l.id = coalesce(d.location_id, $3) where d.id = $1 and d.property_id = $2`, [id, h.propertyId, h.locationId])).rows[0];
    if (!d) throw new AppError(404, 'not_found', 'Device not found.');
    return { h, d };
  }

  async deviceView(p: Principal, id: string) {
    const { h, d } = await this.device(p, id);
    const viewers = (await this.db.query(`select 1 + count(*) filter (where can_view_live)::int as n from property_members where property_id = $1`, [h.propertyId])).rows[0].n;
    const openRepair = (await this.db.query(`select id, number from install_jobs where device_id = $1 and kind = 'repair' and confirmed_at is null and state <> 'cancelled' order by created_at desc limit 1`, [id])).rows[0];
    const base = {
      id: d.id,
      type: d.type,
      name: d.name ?? (d.type === 'camera' ? 'Camera' : 'Street light'),
      status: d.status,
      line: this.deviceLine(d),
      lastSeen: d.last_seen,
      lastSeenText: `Last seen ${ago(d.last_seen)}${d.last_seen ? `, ${hm(d.last_seen)}` : ''}`,
      openRepair: openRepair ? { id: openRepair.id, number: openRepair.number } : null,
      canReport: h.canReport,
      isOwner: h.role === 'owner',
    };
    if (d.type === 'street_light') {
      const used = (await this.db.query(`select count(*)::int as n from device_events where device_id = $1 and kind = 'boost' and at > now() - interval '12 hours'`, [id])).rows[0].n;
      return {
        ...base,
        place: `Outside your home${d.postcode ? `, ${d.postcode}` : ''}`,
        now: d.status === 'offline' ? 'Not responding' : d.boost_until && new Date(d.boost_until) > new Date() ? `On for you until ${hm(d.boost_until)}` : 'On, dusk to dawn',
        power: `Solar, battery ${d.battery_pct ?? '?'}%`,
        lowBattery: (d.battery_pct ?? 100) < DEVICE_RULES.lowBatteryPct,
        litHours: d.lit_hours != null ? Number(d.lit_hours) : null,
        lastCheck: ago(d.last_seen),
        boost: { minutes: DEVICE_RULES.boostMinutes, usedTonight: used, limit: DEVICE_RULES.boostsPerNight, until: d.boost_until && new Date(d.boost_until) > new Date() ? d.boost_until : null },
      };
    }
    const clips = await this.db.query(`select id, kind, payload, at from device_events where device_id = $1 and kind in ('clip', 'motion') order by at desc limit 20`, [id]);
    return {
      ...base,
      canViewLive: h.canViewLive,
      settings: { recordingDays: d.settings?.recordingDays ?? 7, shareWithResponders: d.settings?.shareWithResponders ?? 'emergency_only' },
      recordingDaysOptions: DEVICE_RULES.recordingDaysOptions,
      viewers,
      lastMotion: d.last_motion_at ? hm(d.last_motion_at) : 'None yet',
      clips: clips.rows.map((c) => ({ id: c.id, kind: c.kind, label: c.kind === 'clip' ? 'Saved clip' : 'Motion', seconds: c.payload?.seconds ?? 30, at: c.at })),
      offlineSteps: d.status === 'offline' ? ['Check the power cable and socket', 'Check your Wi-Fi or data is on', 'Restart the camera from its power switch'] : [],
    };
  }

  async settings(p: Principal, id: string, b: { recordingDays?: number; shareWithResponders?: 'emergency_only' | 'never' }) {
    const { h, d } = await this.device(p, id);
    if (h.role !== 'owner') throw new AppError(403, 'owner_only', 'Only the home owner can change camera settings.');
    if (d.type !== 'camera') throw new AppError(422, 'not_camera', 'Only cameras have these settings.');
    if (b.recordingDays != null && !(DEVICE_RULES.recordingDaysOptions as readonly number[]).includes(b.recordingDays)) throw new AppError(422, 'validation_failed', 'Choose how many days to keep.');
    await this.db.query(`update devices set settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify(b)]);
    await this.audit.write({ actorId: p.userId, action: 'device.settings', entity: 'device', entityId: id, payload: b });
    return { message: 'Saved.' };
  }

  async saveClip(p: Principal, id: string) {
    const { h, d } = await this.device(p, id);
    if (d.type !== 'camera') throw new AppError(422, 'not_camera', 'Only cameras record clips.');
    if (!h.canViewLive) throw new AppError(403, 'no_access', 'The home owner has not let you see this camera.');
    if (d.status === 'offline') throw new AppError(409, 'offline', 'The camera is offline, so there is nothing to save.');
    await this.db.query(`insert into device_events (device_id, kind, payload) values ($1, 'clip', $2)`, [id, { by: p.userId, seconds: 30 }]);
    return { message: 'Saved the last 30 seconds to Clips.' };
  }

  /** "Light up the street for 1 hour", limited per night (B6). */
  async boost(p: Principal, id: string) {
    const { d } = await this.device(p, id);
    if (d.type !== 'street_light') throw new AppError(422, 'not_light', 'Only street lights can be turned on.');
    if (d.status === 'offline') throw new AppError(409, 'offline', 'The light is not responding. Report a problem instead.');
    const used = (await this.db.query(`select count(*)::int as n from device_events where device_id = $1 and kind = 'boost' and at > now() - interval '12 hours'`, [id])).rows[0].n;
    if (used >= DEVICE_RULES.boostsPerNight) throw new AppError(429, 'boost_limit', `You can do this ${DEVICE_RULES.boostsPerNight} times a night. If you feel unsafe, report an emergency.`);
    const until = (
      await this.db.query(`update devices set boost_until = greatest(coalesce(boost_until, now()), now()) + make_interval(mins => $2) where id = $1 returning boost_until`, [id, DEVICE_RULES.boostMinutes])
    ).rows[0].boost_until;
    await this.db.query(`insert into device_events (device_id, kind, payload) values ($1, 'boost', $2)`, [id, { by: p.userId }]);
    return { until, message: `The street light is on until ${hm(until)}.` };
  }

  // ---------------------------------------------------------------- repairs (B5; boards "Report a device problem", "Repair status")

  async report(p: Principal, b: { deviceId: string; problem: string; description: string; bestTime?: string }) {
    const bad = checkRepairReport(b);
    if (bad) throw new AppError(422, 'validation_failed', bad.message, { fields: [{ field: bad.field, message: bad.message }] });
    const { h, d } = await this.device(p, b.deviceId);
    if (!h.canReport) throw new AppError(403, 'no_access', 'Ask the home owner to report this, or to let you report for the home.');
    return this.db.tx(async (c) => {
      const open = (await c.query(`select number from install_jobs where device_id = $1 and kind = 'repair' and confirmed_at is null and state <> 'cancelled' limit 1`, [d.id])).rows[0];
      if (open) throw new AppError(409, 'repair_open', `A repair for this device is already open: ${open.number}.`);
      const sub = (await c.query(`select id, state from subscriptions where property_id = $1 and state <> 'cancelled' order by created_at desc limit 1`, [h.propertyId])).rows[0];
      const urgent = DEVICE_RULES.urgentProblems.includes(b.problem);
      let number = '';
      for (;;) {
        number = `RP-${randomInt(100000, 1000000)}`;
        if (!(await c.query(`select 1 from install_jobs where number = $1`, [number])).rowCount) break;
      }
      const j = await c.query(
        `insert into install_jobs (kind, property_id, subscription_id, number, device_id, problem, description, best_time, urgent, reported_by, covered)
         values ('repair', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [h.propertyId, sub?.id ?? null, number, d.id, b.problem, b.description.trim(), b.bestTime?.trim() || null, urgent, p.userId, !!sub && sub.state === 'active'],
      );
      await c.query(`update devices set status = $2 where id = $1 and status <> 'offline'`, [d.id, urgent ? 'tamper' : 'needs_repair']);
      const admins = (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id);
      await notify(c, admins, { type: 'repair_reported', grp: 'account', title: urgent ? 'Urgent: device damaged' : 'Device problem', body: `${d.name ?? d.type} at ${d.postcode ?? 'a home'}: ${problemLabel(b.problem)}. ${number}.`, link: '/admin/repairs' });
      if (urgent) {
        // Damage or tampering may be a crime in progress: tell the station that covers this home.
        const station = (
          await c.query(
            `select s.id from stations s join agencies a on a.id = s.agency_id and a.kind = 'police' left join locations sl on sl.id = s.location_id
              where s.status = 'active' order by st_distance(coalesce(sl.geom, s.zone::geography), (select geom from locations where id = $1)) nulls last limit 1`,
            [h.locationId],
          )
        ).rows[0];
        if (station) {
          const heads = (await c.query(`select user_id from user_roles where scope_type = 'station' and scope_id = $1 and role in ('head', 'dispatcher')`, [station.id])).rows.map((x) => x.user_id);
          await notify(c, heads, { type: 'device_tamper', grp: 'dispatch', title: 'Home device damaged', body: `A camera or light at ${d.postcode ?? 'a home'} may have been damaged or moved. The owner reported it.`, link: '/incidents' });
        }
      }
      await this.audit.write({ actorId: p.userId, action: 'repair.reported', entity: 'install_job', entityId: j.rows[0].id, payload: { problem: b.problem, urgent } }, c);
      return { id: j.rows[0].id, number, urgent, message: urgent ? `Reported as urgent. ${number}. We have told your local station.` : `Reported. ${number}. We will check the device and book a visit if needed.` };
    });
  }

  private async repairRow(p: Principal, id: string) {
    const h = await this.mustHome(p);
    const j = (
      await this.db.query(
        `select j.*, d.name as device, d.type as device_type, u.display_name as tech_name, t.vetted_at
           from install_jobs j left join devices d on d.id = j.device_id
           left join users u on u.id = j.technician_id left join technicians t on t.user_id = j.technician_id
          where j.id = $1 and j.property_id = $2 and j.kind = 'repair'`,
        [id, h.propertyId],
      )
    ).rows[0];
    if (!j) throw new AppError(404, 'not_found', 'Repair not found.');
    return j;
  }

  async repair(p: Principal, id: string) {
    const j = await this.repairRow(p, id);
    const step = repairStep({ faultConfirmedAt: j.fault_confirmed_at, bookedAt: j.booked_at, fixedAt: j.fixed_at, confirmedAt: j.confirmed_at, state: j.state });
    const order = ['received', 'confirmed', 'booked', 'fixed', 'closed'];
    const at = order.indexOf(step);
    const steps = [
      { key: 'received', title: 'Report received', line: j.urgent ? 'Marked urgent' : 'We checked the device remotely', at: j.created_at },
      { key: 'confirmed', title: 'Fault confirmed', line: 'Needs a visit', at: j.fault_confirmed_at },
      { key: 'booked', title: 'Visit booked', line: j.tech_name ? `Technician ${j.tech_name}` : 'A technician will be assigned', at: j.booked_at },
      { key: 'fixed', title: step === 'closed' ? 'Fixed and confirmed' : 'Fixed', line: step === 'fixed' ? 'Please confirm it works' : 'You will be asked to confirm', at: j.confirmed_at ?? j.fixed_at },
    ].map((s, i) => ({ ...s, state: i < at || step === 'closed' ? 'done' : i === at ? 'current' : 'next' }));
    return {
      id: j.id,
      number: j.number,
      step,
      chip: { received: 'Reported', confirmed: 'Fault confirmed', booked: 'Visit booked', fixed: 'Fixed, confirm', closed: 'Closed' }[step],
      steps,
      device: j.device ?? 'Device',
      problem: problemLabel(j.problem ?? ''),
      description: j.description,
      bestTime: j.best_time,
      visit: j.scheduled_at ? `${day(j.scheduled_at)}, ${j.visit_window ?? hm(j.scheduled_at)}` : null,
      technician: j.tech_name ? `${j.tech_name}${j.vetted_at ? ', verified badge' : ''}` : null,
      cost: j.covered ? 'Free, covered by your plan' : j.quote_kobo ? `Quote ${Number(j.quote_kobo) / 100}` : 'Not covered: we send a quote first',
      covered: j.covered,
      urgent: j.urgent,
      canChangeTime: step !== 'fixed' && step !== 'closed',
      canConfirm: step === 'fixed',
    };
  }

  async changeTime(p: Principal, id: string, bestTime: string) {
    const j = await this.repairRow(p, id);
    if (!bestTime.trim()) throw new AppError(422, 'validation_failed', 'Say when is best for a visit.', { fields: [{ field: 'bestTime', message: 'Say when is best.' }] });
    if (j.fixed_at) throw new AppError(409, 'already_fixed', 'This repair is already done.');
    await this.db.tx(async (c) => {
      // A booked visit goes back to the team to rebook at the new time.
      await c.query(`update install_jobs set best_time = $2, state = case when state = 'scheduled' then 'unassigned' else state end, booked_at = null, scheduled_at = null where id = $1`, [id, bestTime.trim()]);
      const admins = (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id);
      await notify(c, admins, { type: 'repair_time_changed', grp: 'account', title: 'New visit time asked', body: `${j.number}: the owner asked for "${bestTime.trim()}".`, link: '/admin/repairs' });
    });
    return { message: j.booked_at ? 'Asked for a new time. We will book it and tell you.' : 'Saved. We will book a visit at that time.' };
  }

  async confirm(p: Principal, id: string, fixed: boolean) {
    const j = await this.repairRow(p, id);
    if (!j.fixed_at || j.confirmed_at) throw new AppError(409, 'not_fixed', 'There is nothing to confirm yet.');
    await this.db.tx(async (c) => {
      if (fixed) {
        await c.query(`update install_jobs set confirmed_at = now(), state = 'done' where id = $1`, [id]);
      } else {
        await c.query(`update install_jobs set fixed_at = null, booked_at = null, scheduled_at = null, state = 'unassigned' where id = $1`, [id]);
        const admins = (await c.query(`select user_id from user_roles where role = 'platform_admin'`)).rows.map((x) => x.user_id);
        await notify(c, admins, { type: 'repair_reopened', grp: 'account', title: 'Repair reopened', body: `${j.number}: the owner says it still does not work.`, link: '/admin/repairs' });
      }
    });
    return { message: fixed ? 'Thank you. Repair closed.' : 'Sorry. We reopened the repair and will book another visit.' };
  }

  // ---------------------------------------------------------------- platform admin: repair tickets

  private admin(p: Principal) {
    if (!hasRole(p, 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }

  async adminList(p: Principal) {
    this.admin(p);
    const r = await this.db.query(
      `select j.id, j.number, j.problem, j.description, j.best_time, j.urgent, j.state, j.created_at, j.fault_confirmed_at, j.booked_at, j.fixed_at, j.confirmed_at,
              j.scheduled_at, j.visit_window, j.covered, d.name as device, d.status as device_status, l.postcode, l.address_text, u.display_name as owner, tu.display_name as tech
         from install_jobs j join properties pr on pr.id = j.property_id join users u on u.id = pr.owner_id join locations l on l.id = pr.location_id
         left join devices d on d.id = j.device_id left join users tu on tu.id = j.technician_id
        where j.kind = 'repair' and (j.confirmed_at is null or j.confirmed_at > now() - interval '7 days') and j.state <> 'cancelled'
        order by j.confirmed_at is not null, j.urgent desc, j.created_at`,
    );
    const techs = await this.db.query(`select t.user_id as id, u.display_name as name from technicians t join users u on u.id = t.user_id where t.active order by u.display_name`);
    return {
      technicians: techs.rows,
      items: r.rows.map((j) => ({
        id: j.id,
        number: j.number,
        device: j.device,
        deviceStatus: j.device_status,
        problem: problemLabel(j.problem ?? ''),
        description: j.description,
        bestTime: j.best_time,
        urgent: j.urgent,
        covered: j.covered,
        owner: j.owner,
        address: `${j.address_text}, ${j.postcode}`,
        visit: j.scheduled_at ? `${day(j.scheduled_at)}, ${j.visit_window ?? hm(j.scheduled_at)}` : null,
        technician: j.tech,
        step: repairStep({ faultConfirmedAt: j.fault_confirmed_at, bookedAt: j.booked_at, fixedAt: j.fixed_at, confirmedAt: j.confirmed_at, state: j.state }),
        at: j.created_at,
      })),
    };
  }

  async adminAct(p: Principal, id: string, b: { action: 'confirm_fault' | 'book' | 'fixed'; scheduledAt?: string; window?: string; technicianId?: string }) {
    this.admin(p);
    return this.db.tx(async (c) => {
      const j = (await c.query(`select j.*, pr.owner_id, d.name as device from install_jobs j join properties pr on pr.id = j.property_id left join devices d on d.id = j.device_id where j.id = $1 and j.kind = 'repair' for update of j`, [id])).rows[0];
      if (!j) throw new AppError(404, 'not_found', 'Repair not found.');
      if (j.confirmed_at) throw new AppError(409, 'closed', 'This repair is closed.');
      const tell = (title: string, body: string) => notify(c, [j.owner_id, ...(j.reported_by && j.reported_by !== j.owner_id ? [j.reported_by] : [])], { type: 'repair_update', grp: 'account', title, body, link: `/profile/home/repairs/${id}` });
      if (b.action === 'confirm_fault') {
        await c.query(`update install_jobs set fault_confirmed_at = coalesce(fault_confirmed_at, now()) where id = $1`, [id]);
        await tell('Fault confirmed', `${j.number}: we confirmed the fault on ${j.device ?? 'your device'}. We will book a visit.`);
      } else if (b.action === 'book') {
        if (!b.scheduledAt || !b.window) throw new AppError(422, 'validation_failed', 'Choose a date and a time window.', { fields: [{ field: 'scheduledAt', message: 'Choose a date.' }] });
        const tech = b.technicianId ?? (await c.query(`select user_id from technicians where active order by vetted_at limit 1`)).rows[0]?.user_id;
        if (!tech) throw new AppError(422, 'no_technician', 'Add a technician first.');
        await c.query(
          `update install_jobs set fault_confirmed_at = coalesce(fault_confirmed_at, now()), booked_at = now(), scheduled_at = $2, visit_window = $3, technician_id = $4, state = 'scheduled' where id = $1`,
          [id, b.scheduledAt, b.window, tech],
        );
        const name = (await c.query(`select display_name from users where id = $1`, [tech])).rows[0].display_name;
        await notify(c, [tech], { type: 'repair_assigned', grp: 'account', title: 'Repair visit', body: `${j.number}: ${day(b.scheduledAt)}, ${b.window}.`, link: `/jobs/${id}` });
        await tell('Visit booked', `${j.number}: ${name} visits on ${day(b.scheduledAt)}, ${b.window}. They show a badge and a code; never let anyone in without both.`);
      } else {
        if (!j.booked_at) throw new AppError(409, 'not_booked', 'Book the visit first.');
        await c.query(`update install_jobs set fixed_at = now() where id = $1`, [id]);
        await c.query(`update devices set status = 'online', last_seen = now() where id = $1`, [j.device_id]);
        await tell('Fixed: please confirm', `${j.number}: ${j.device ?? 'your device'} is fixed. Open the repair to confirm it works.`);
      }
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: `repair.${b.action}`, entity: 'install_job', entityId: id, payload: b }, c);
      return { message: { confirm_fault: 'Fault confirmed.', book: 'Visit booked.', fixed: 'Marked fixed. The owner is asked to confirm.' }[b.action] };
    });
  }
}
