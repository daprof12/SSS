// Agency overview and stations (boards "Agency overview", "Agency stations"), and the platform admin
// overview, users, subscriptions, KYC queue and live incident map (boards "Admin overview",
// "Admin users and add user", "Admin subscriptions", "Admin KYC queue", "Admin live incident map").
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../core/audit';
import { hasRole, type Principal } from '../core/auth';
import { Db } from '../core/db';
import { AppError } from '../core/http';
import { notify } from '../reports/shared';
import { locationWhere, type LocationFilter } from '../core/location-filter';

const OPEN = `('received', 'offered', 'escalated', 'accepted', 'en_route', 'reassigning', 'transferred', 'on_scene', 'closing')`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KIND: Record<string, string> = { police: 'Police', fire: 'Fire service', health: 'Ambulance and health', frsc: 'Road safety', roads: 'Roads' };
export type Kind = 'emergency' | 'tip' | 'issue';
export interface LiveItem {
  id: string;
  kind: Kind;
  label: string;
  state: string;
  lat: number;
  lng: number;
  at: string;
  line: string;
  reports: number;
  href: string;
}
const MONTH = `date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`;

@Injectable()
export class OverviewService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  private async agencyStaff(p: Principal, agencyId: string) {
    if (!p.roles.some((r) => ['agency_admin', 'agency_finance'].includes(r.role) && r.scopeId === agencyId) && !hasRole(p, 'platform_admin')) {
      throw new AppError(404, 'not_found', 'Agency not found.');
    }
  }

  private admin(p: Principal) {
    if (!hasRole(p, 'platform_admin')) throw new AppError(403, 'forbidden', 'This page is for platform staff.');
  }

  // ---------------------------------------------------------------- agency

  async agencyOverview(p: Principal, agencyId: string) {
    await this.agencyStaff(p, agencyId);
    const open = (await this.db.query(`select count(*)::int as n from incidents where agency_id = $1 and state in ${OPEN}`, [agencyId])).rows[0].n;
    const resp = (
      await this.db.query(`select avg(extract(epoch from (x.arrived_at - x.accepted_at))) as s from incident_units x join incidents i on i.id = x.incident_id where i.agency_id = $1 and x.arrived_at > now() - interval '30 days'`, [agencyId])
    ).rows[0].s;
    const acc = (
      await this.db.query(
        `select count(*) filter (where x.accepted_at is not null)::int as a, count(*) filter (where x.state in ('declined', 'expired') or x.accepted_at is not null)::int as n
           from incident_units x join stations s on s.id = x.station_id where s.agency_id = $1 and x.offered_at > now() - interval '30 days' and x.role = 'primary'`,
        [agencyId],
      )
    ).rows[0];
    const rating = (await this.db.query(`select round(avg(r.stars)::numeric, 1) as r from ratings r join incidents i on i.id = r.incident_id where i.agency_id = $1 and r.created_at > now() - interval '30 days'`, [agencyId])).rows[0].r;
    const donations = (
      await this.db.query(
        `select coalesce(sum(d.amount_kobo), 0)::bigint as k from donations d
           left join stations s on d.target_type = 'station' and s.id = d.target_id left join officers o on d.target_type = 'officer' and o.user_id = d.target_id left join stations so on so.id = o.station_id
          where d.state = 'paid' and d.paid_at > ${MONTH} and (d.target_type = 'agency' and d.target_id = $1 or s.agency_id = $1 or so.agency_id = $1)`,
        [agencyId],
      )
    ).rows[0].k;
    const live = await this.db.query(
      `select i.id, i.type, i.state, i.created_at, l.postcode, s.name as station from incidents i left join locations l on l.id = i.location_id left join stations s on s.id = i.station_id
        where i.agency_id = $1 and i.state in ${OPEN} order by i.state = 'escalated' desc, i.created_at desc limit 8`,
      [agencyId],
    );
    const stations = await this.stationRows(agencyId);
    const week = await this.db.query(
      `select extract(isodow from created_at at time zone 'Africa/Lagos')::int as d, count(*)::int as n from incidents where agency_id = $1 and created_at > now() - interval '7 days' and state <> 'merged' group by 1`,
      [agencyId],
    );
    const waitingId = (await this.db.query(`select count(*)::int as n from officers o join stations s on s.id = o.station_id where s.agency_id = $1 and o.badge_status = 'pending'`, [agencyId])).rows[0].n;
    const bank = (await this.db.query(`select 1 from bank_accounts where owner_type = 'agency' and owner_id = $1 and removed_at is null`, [agencyId])).rowCount;
    return {
      stats: {
        open,
        avgResponseS: resp == null ? null : Math.round(Number(resp)),
        acceptancePct: acc.n ? Math.round((acc.a / acc.n) * 100) : null,
        rating: rating == null ? null : Number(rating),
        donationsMonthKobo: Number(donations),
      },
      live: live.rows.map((i) => ({ id: i.id, label: `${cap(i.type)}, ${i.postcode ?? 'GPS'}`, state: i.state, station: i.station, at: i.created_at })),
      stations: stations.slice(0, 6),
      week: DAYS.map((d, i) => ({ day: d, n: week.rows.find((r) => r.d === i + 1)?.n ?? 0 })),
      attention: [
        ...(waitingId ? [{ key: 'id_check', title: 'Officers waiting for ID check', line: 'They cannot take reports yet', count: String(waitingId), href: '/agency/officers' }] : []),
        ...(stations.filter((s) => s.status === 'active' && s.onDuty === 0).length
          ? [{ key: 'nobody', title: 'Stations with nobody on duty', line: 'Reports will go to the next station', count: String(stations.filter((s) => s.status === 'active' && s.onDuty === 0).length), href: '/agency/stations' }]
          : []),
        ...(!bank ? [{ key: 'bank', title: 'Payout bank details', line: 'Add before the next payout run', count: 'Open', href: '/agency/payouts' }] : []),
      ],
    };
  }

  private async stationRows(agencyId: string) {
    const r = await this.db.query(
      `select s.id, s.name, s.status, l.postcode, hu.display_name as head,
              (select count(*)::int from officers o where o.station_id = s.id) as officers,
              (select count(*)::int from officers o where o.station_id = s.id and o.on_duty) as on_duty,
              (select count(*)::int from incidents i where i.station_id = s.id and i.state in ${OPEN}) as open,
              (select round(avg(r.stars)::numeric, 1) from ratings r join incidents i on i.id = r.incident_id where i.station_id = s.id and r.created_at > now() - interval '30 days') as rating,
              (select count(*)::int from incidents i where i.station_id = s.id and i.created_at > now() - interval '30 days' and i.state <> 'merged') as month
         from stations s left join locations l on l.id = s.location_id left join users hu on hu.id = s.head_user_id where s.agency_id = $1 order by s.name`,
      [agencyId],
    );
    return r.rows.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      postcode: s.postcode,
      head: s.head,
      officers: s.officers,
      onDuty: s.on_duty,
      open: s.open,
      rating: s.rating == null ? null : Number(s.rating),
      reportsMonth: s.month,
    }));
  }

  async agencyStations(p: Principal, agencyId: string) {
    await this.agencyStaff(p, agencyId);
    return this.stationRows(agencyId);
  }

  // ---------------------------------------------------------------- platform admin

  async adminOverview(p: Principal, f?: LocationFilter) {
    this.admin(p);
    const q = async (sql: string, args: unknown[] = []) => (await this.db.query(sql, args)).rows[0];
    // Every place-bound number follows "Filter by location": incidents by their building, devices
    // and subscriptions by the home they belong to.
    const inc = (extra: string) => {
      const args: unknown[] = [];
      const w = locationWhere(f, args);
      return { sql: `from incidents i left join locations l on l.id = i.location_id where ${w} and ${extra}`, args };
    };
    const o = inc(`i.state in ${OPEN}`);
    const open = (await q(`select count(*)::int as n ${o.sql}`, o.args)).n;
    const r0 = inc(`x.arrived_at > now() - interval '30 days'`);
    const resp = (await q(`select avg(extract(epoch from (x.arrived_at - x.accepted_at))) as s from incident_units x join incidents i on i.id = x.incident_id left join locations l on l.id = i.location_id where ${r0.sql.split(' where ')[1]}`, r0.args)).s;
    const sa: unknown[] = [];
    const subs = (await q(`select count(*)::int as n from subscriptions s join properties pr on pr.id = s.property_id join locations l on l.id = pr.location_id where ${locationWhere(f, sa)} and s.state in ('active', 'grace', 'extras_paused', 'sharing_paused')`, sa)).n;
    const da: unknown[] = [];
    const dev = await q(
      `select count(*)::int as total, count(*) filter (where d.status = 'online')::int as online, count(*) filter (where d.status = 'low_power')::int as low,
              count(*) filter (where d.status = 'offline')::int as offline, count(*) filter (where d.status = 'needs_repair')::int as repair, count(*) filter (where d.status = 'tamper')::int as tamper
         from devices d left join properties pr on pr.id = d.property_id left join locations l on l.id = coalesce(d.location_id, pr.location_id)
        where d.type in ('camera', 'street_light') and ${locationWhere(f, da)}`,
      da,
    );
    const fq = inc(`i.closed_at > now() - interval '30 days'`);
    const fa = await q(`select count(*) filter (where i.state = 'unfounded')::int as f, count(*) filter (where i.state in ('resolved', 'unfounded'))::int as n ${fq.sql}`, fq.args);
    const kyc = (await q(`select count(distinct user_id)::int as n from kyc_verifications k where status = 'manual_review' and not exists (select 1 from kyc_verifications k2 where k2.user_id = k.user_id and k2.created_at > k.created_at)`)).n;
    const wq = inc(`i.created_at > now() - interval '7 days' and i.state <> 'merged'`);
    const week = (await this.db.query(`select extract(isodow from i.created_at at time zone 'Africa/Lagos')::int as d, count(*)::int as n ${wq.sql} group by 1`, wq.args)).rows;
    const tamper = await q(`select count(*)::int as n, min(created_at) as oldest from install_jobs where kind = 'repair' and urgent and confirmed_at is null and state <> 'cancelled'`);
    const eq = inc(`i.state = 'escalated'`);
    const escalated = (await q(`select count(*)::int as n ${eq.sql}`, eq.args)).n;
    const appeals = await q(`select count(*)::int as n, min(appealed_at) as oldest from fines where state = 'appealed'`);
    const agencies = (await q(`select count(*)::int as n from agencies where status in ('documents_submitted', 'in_review')`)).n;
    const failed = (await q(`select count(*)::int as n from dunning_state`)).n;
    const byKind = (
      await this.db.query(
        `select a.kind, count(*) filter (where x.accepted_at is not null)::int as a, count(*)::int as n,
                avg(extract(epoch from (x.arrived_at - x.accepted_at))) filter (where x.arrived_at is not null) as s
           from incident_units x join stations s on s.id = x.station_id join agencies a on a.id = s.agency_id
          where x.offered_at > now() - interval '30 days' and x.role = 'primary' and (x.accepted_at is not null or x.state in ('declined', 'expired')) group by a.kind order by count(*) desc`,
      )
    ).rows;
    const money = await q(
      `select coalesce(sum(amount_kobo) filter (where purpose = 'subscription'), 0)::bigint as subs, coalesce(sum(amount_kobo) filter (where purpose = 'install'), 0)::bigint as install,
              coalesce(sum(amount_kobo) filter (where purpose = 'fine'), 0)::bigint as fines
         from payments where state = 'succeeded' and paid_at > ${MONTH}`,
    );
    const donationFee = (await q(`select coalesce(sum(l.amount_kobo), 0)::bigint as k from wallet_ledger l join wallets w on w.id = l.wallet_id where w.owner_type = 'platform_fees' and l.type = 'donation_in' and l.created_at > ${MONTH}`)).k;
    return {
      stats: {
        open,
        avgResponseS: resp == null ? null : Math.round(Number(resp)),
        activeSubscriptions: subs,
        devicesOnlinePct: dev.total ? Math.round((dev.online / dev.total) * 100) : null,
        falseAlarmPct: fa.n ? Math.round((fa.f / fa.n) * 100) : null,
        kycWaiting: kyc,
      },
      week: DAYS.map((d, i) => ({ day: d, n: week.find((r) => r.d === i + 1)?.n ?? 0 })),
      devices: { online: dev.online, low: dev.low, offline: dev.offline, repair: dev.repair, tamper: dev.tamper, total: dev.total },
      attention: [
        { key: 'tamper', title: 'Tamper alerts not yet handled', line: tamper.oldest ? `Oldest ${new Date(tamper.oldest).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'None', count: tamper.n, href: '/admin/repairs', tone: 'critical' },
        { key: 'escalated', title: 'Reports with no taker', line: 'Escalated to the next station', count: escalated, href: '/admin/live', tone: 'critical' },
        { key: 'appeals', title: 'Appeals waiting', line: appeals.oldest ? `Oldest ${Math.max(0, Math.floor((Date.now() - +new Date(appeals.oldest)) / 86_400_000))} days` : 'None', count: appeals.n, href: '/admin/fines', tone: 'warning' },
        { key: 'agencies', title: 'Agencies waiting for approval', line: 'Documents uploaded', count: agencies, href: '/admin/agencies', tone: 'warning' },
        { key: 'payments', title: 'Payments failed', line: 'Home plans in a payment problem', count: failed, href: '/admin/subscriptions', tone: 'warning' },
      ],
      agencyResponse: byKind.map((k) => ({ kind: k.kind, label: KIND[k.kind] ?? cap(k.kind), acceptedPct: k.n ? Math.round((k.a / k.n) * 100) : null, avgResponseS: k.s == null ? null : Math.round(Number(k.s)) })),
      money: { subscriptionsKobo: Number(money.subs), installKobo: Number(money.install), donationFeeKobo: Number(donationFee), finesKobo: Number(money.fines) },
    };
  }

  async users(p: Principal, b: { role: string; q?: string } & LocationFilter) {
    this.admin(p);
    const roleFilter: Record<string, string> = {
      all: 'true',
      citizens: `not exists (select 1 from user_roles r where r.user_id = u.id and r.role <> 'citizen')`,
      owners: `exists (select 1 from properties pr where pr.owner_id = u.id)`,
      officers: `exists (select 1 from officers o where o.user_id = u.id)`,
      heads: `exists (select 1 from user_roles r where r.user_id = u.id and r.role = 'head')`,
      technicians: `exists (select 1 from technicians t where t.user_id = u.id)`,
      staff: `exists (select 1 from user_roles r where r.user_id = u.id and r.role in ('agency_admin', 'agency_finance', 'platform_admin', 'dispatcher'))`,
    };
    // A person's place is their home building (or their station's, for officers).
    const uargs: unknown[] = [b.q?.trim() || null];
    const place = locationWhere(b, uargs);
    const userPlace =
      place === 'true'
        ? 'true'
        : `(exists (select 1 from saved_places sp join locations l on l.id = sp.location_id where sp.user_id = u.id and sp.is_home and ${place})
            or exists (select 1 from officers o join stations st on st.id = o.station_id join locations l on l.id = st.location_id where o.user_id = u.id and ${place}))`;
    const r = await this.db.query(
      `select u.id, u.display_name, u.phone, u.status, u.created_at,
              (select string_agg(distinct r.role, ',') from user_roles r where r.user_id = u.id) as roles,
              exists (select 1 from properties pr where pr.owner_id = u.id) as owner,
              (select o.badge_status from officers o where o.user_id = u.id) as badge,
              (select k.status from kyc_verifications k where k.user_id = u.id order by k.created_at desc limit 1) as kyc,
              (select l.postcode from saved_places sp join locations l on l.id = sp.location_id where sp.user_id = u.id and sp.is_home limit 1) as postcode
         from users u where ${roleFilter[b.role] ?? 'true'} and ($1::text is null or u.display_name ilike '%' || $1 || '%' or u.phone like '%' || $1 || '%'
           or exists (select 1 from saved_places sp join locations l on l.id = sp.location_id where sp.user_id = u.id and replace(l.postcode, ' ', '') ilike replace($1, ' ', '') || '%'))
          and ${userPlace}
        order by u.created_at desc limit 200`,
      uargs,
    );
    const roleLabel = (x: { roles: string | null; owner: boolean; badge: string | null }) => {
      const rs = (x.roles ?? '').split(',');
      if (rs.includes('platform_admin')) return 'Platform admin';
      if (rs.includes('agency_admin')) return 'Agency admin';
      if (rs.includes('head')) return 'Station head';
      if (rs.includes('technician')) return 'Technician';
      if (x.badge) return 'Officer';
      if (x.owner) return 'Household owner';
      return 'Citizen';
    };
    return r.rows.map((u) => ({
      id: u.id,
      name: u.display_name,
      phone: u.phone ? `${u.phone.slice(0, 7)}•••${u.phone.slice(-2)}` : null,
      role: roleLabel(u),
      postcode: u.postcode,
      kyc: u.badge === 'pending' ? 'badge_check' : (u.kyc ?? 'not_started'),
      status: u.status,
      joined: u.created_at,
    }));
  }

  async subscriptions(p: Principal, state: string, f?: LocationFilter) {
    this.admin(p);
    const largs: unknown[] = [];
    const place = locationWhere(f, largs);
    const filter: Record<string, string> = {
      all: `s.state <> 'draft'`,
      active: `s.state = 'active'`,
      due: `s.state in ('grace', 'extras_paused', 'sharing_paused', 'switched_off')`,
      install: `s.state in ('install_pending', 'install_booked')`,
      cancelled: `s.state = 'cancelled'`,
    };
    const r = await this.db.query(
      `select s.id, s.state, s.next_bill_at, s.last_paid_at, s.autopay_from_wallet, s.created_at, pl.name as plan, pl.price_kobo, u.display_name as owner, l.postcode, l.area_label,
              (select count(*)::int from devices d where d.property_id = s.property_id) as devices,
              (select count(*) filter (where d.type = 'camera')::int from devices d where d.property_id = s.property_id) as cameras,
              (select count(*) filter (where d.type = 'street_light')::int from devices d where d.property_id = s.property_id) as lights,
              ds.due_since, ds.arrangement,
              (select p2.paid_at from payments p2 where p2.purpose = 'install' and p2.purpose_ref = s.id and p2.state = 'succeeded' limit 1) as install_paid
         from subscriptions s join plans pl on pl.code = s.plan_code join properties pr on pr.id = s.property_id join users u on u.id = pr.owner_id join locations l on l.id = pr.location_id
         left join dunning_state ds on ds.subscription_id = s.id
        where ${filter[state] ?? filter.all} and ${place} order by s.created_at desc limit 200`,
      largs,
    );
    const stats = (
      await this.db.query(
        `select count(*) filter (where s.state = 'active')::int as active, coalesce(sum(pl.price_kobo) filter (where s.state in ('active', 'grace', 'extras_paused', 'sharing_paused')), 0)::bigint as mrr,
                count(*) filter (where s.state in ('grace', 'extras_paused', 'sharing_paused', 'switched_off'))::int as due,
                count(*) filter (where s.state = 'cancelled' and s.updated_at > ${MONTH})::int as cancelled
           from subscriptions s join plans pl on pl.code = s.plan_code`,
      )
    ).rows[0];
    return {
      stats: { active: stats.active, monthlyKobo: Number(stats.mrr), due: stats.due, cancelledMonth: stats.cancelled },
      items: r.rows.map((s) => ({
        id: s.id,
        owner: s.owner,
        postcode: s.postcode,
        area: s.area_label,
        plan: s.plan,
        priceKobo: Number(s.price_kobo),
        devices: s.devices,
        cameras: s.cameras,
        lights: s.lights,
        state: s.state,
        nextBill: s.next_bill_at,
        lastPaid: s.last_paid_at,
        installPaid: s.install_paid,
        dueSince: s.due_since,
        arrangement: s.arrangement,
        autopayFromWallet: s.autopay_from_wallet,
      })),
    };
  }

  async subscriptionAction(p: Principal, id: string, b: { action: 'remind' | 'pause' | 'resume' | 'change_plan'; planCode?: string; reason?: string }) {
    this.admin(p);
    const s = (await this.db.query(`select s.*, pr.owner_id, pl.name, pl.price_kobo from subscriptions s join properties pr on pr.id = s.property_id join plans pl on pl.code = s.plan_code where s.id = $1`, [id])).rows[0];
    if (!s) throw new AppError(404, 'not_found', 'Subscription not found.');
    if (b.action === 'remind') {
      const due = ['grace', 'extras_paused', 'sharing_paused', 'switched_off'].includes(s.state);
      await notify(this.db.pool, [s.owner_id], {
        type: 'billing_reminder',
        grp: 'money',
        title: due ? 'Payment reminder' : 'Your home plan',
        body: due ? 'Your monthly payment for the home plan is still due. Pay now to keep everything on.' : `Your ${s.name} plan renews soon.`,
        link: '/profile/home/billing',
      });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'subscription.remind', entity: 'subscription', entityId: id });
      return { message: 'Reminder sent.' };
    }
    if (b.action === 'change_plan') {
      const pl = (await this.db.query(`select code, name from plans where code = $1`, [b.planCode ?? ''])).rows[0];
      if (!pl) throw new AppError(422, 'validation_failed', 'Choose a plan.');
      await this.db.query(`update subscriptions set plan_code = $2 where id = $1`, [id, pl.code]);
      await notify(this.db.pool, [s.owner_id], { type: 'plan_changed', grp: 'money', title: 'Plan changed', body: `Your home plan is now ${pl.name} from the next bill.`, link: '/profile/home/billing' });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'subscription.change_plan', entity: 'subscription', entityId: id, payload: { to: pl.code } });
      return { message: `Changed to ${pl.name}.` };
    }
    // Pause and resume need a reason (States doc: "manual restore needs a reason").
    if (!b.reason || b.reason.trim().length < 3) throw new AppError(422, 'validation_failed', 'Give a reason; it is logged.', { fields: [{ field: 'reason', message: 'Give a reason.' }] });
    const to = b.action === 'pause' ? 'paused' : 'active';
    if (b.action === 'pause' && !['active', 'grace'].includes(s.state)) throw new AppError(409, 'invalid', 'Only an active plan can be paused.');
    if (b.action === 'resume' && s.state !== 'paused') throw new AppError(409, 'invalid', 'Only a paused plan can be resumed.');
    await this.db.query(`update subscriptions set state = $2 where id = $1`, [id, to]);
    await notify(this.db.pool, [s.owner_id], { type: 'plan_paused', grp: 'money', title: b.action === 'pause' ? 'Plan paused' : 'Plan resumed', body: b.action === 'pause' ? 'Your home plan is paused. Emergency reporting still works.' : 'Your home plan is back on.', link: '/profile/home/billing' });
    await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: `subscription.${b.action}`, entity: 'subscription', entityId: id, payload: { reason: b.reason } });
    return { message: b.action === 'pause' ? 'Paused.' : 'Resumed.' };
  }

  async kycQueue(p: Principal) {
    this.admin(p);
    const r = await this.db.query(
      `select k.id, k.user_id, k.id_type, k.id_masked, k.selfie_match, k.liveness, k.status, k.failure_reason, k.created_at, u.display_name,
              (select string_agg(distinct r.role, ',') from user_roles r where r.user_id = u.id) as roles
         from kyc_verifications k join users u on u.id = k.user_id
        where k.status in ('manual_review', 'failed') and not exists (select 1 from kyc_verifications k2 where k2.user_id = k.user_id and k2.created_at > k.created_at)
        order by k.status = 'manual_review' desc, k.created_at`,
    );
    return r.rows.map((k) => ({
      id: k.id,
      userId: k.user_id,
      name: k.display_name,
      role: (k.roles ?? '').includes('officer') ? 'Officer' : (k.roles ?? '').includes('technician') ? 'Technician' : 'Citizen',
      idType: k.id_type.toUpperCase(),
      idMasked: k.id_masked,
      faceMatchPct: k.selfie_match == null ? null : Math.round(Number(k.selfie_match) * 100),
      liveness: k.liveness,
      status: k.status,
      reason: k.failure_reason,
      at: k.created_at,
    }));
  }

  async kycDecide(p: Principal, id: string, b: { decision: 'approve' | 'reject' | 'more'; reason?: string }) {
    this.admin(p);
    if (b.decision !== 'approve' && (!b.reason || b.reason.trim().length < 5)) throw new AppError(422, 'validation_failed', 'Give a reason the person will read.', { fields: [{ field: 'reason', message: 'Give a reason.' }] });
    const k = (await this.db.query(`select * from kyc_verifications where id = $1`, [id])).rows[0];
    if (!k) throw new AppError(404, 'not_found', 'Case not found.');
    if (k.status !== 'manual_review') throw new AppError(409, 'decided', 'This case is already decided.');
    await this.db.tx(async (c) => {
      if (b.decision === 'approve') await c.query(`update kyc_verifications set status = 'verified', verified_at = now() where id = $1`, [id]);
      else await c.query(`update kyc_verifications set status = 'failed', failure_reason = $2 where id = $1`, [id, b.decision === 'more' ? `more_info: ${b.reason}` : b.reason]);
      await notify(c, [k.user_id], {
        type: 'kyc_decided',
        grp: 'account',
        title: b.decision === 'approve' ? 'Identity verified' : b.decision === 'more' ? 'More needed for your ID check' : 'ID check not passed',
        body: b.decision === 'approve' ? 'Your identity is verified. Wallet, tips and rewards are open to you.' : b.reason!,
        link: '/profile',
      });
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: `kyc.${b.decision}`, entity: 'kyc', entityId: id, payload: { reason: b.reason } }, c);
    });
    return { message: b.decision === 'approve' ? 'Approved.' : b.decision === 'more' ? 'Asked for more.' : 'Rejected.' };
  }

  /**
   * Live map of reports (board "Admin live incident map", and each agency's own map): emergencies
   * (open incidents), tips (with a place) and public issues (not fixed), filtered by kind and place.
   * An agency sees only what is routed to it; the platform sees everything.
   */
  async live(p: Principal, scope: { agencyId: string | null }, kinds: Kind[], f?: LocationFilter) {
    if (scope.agencyId) await this.agencyStaff(p, scope.agencyId);
    else this.admin(p);
    const want = new Set(kinds.length ? kinds : (['emergency', 'tip', 'issue'] as Kind[]));
    const items: LiveItem[] = [];
    if (want.has('emergency')) {
      const args: unknown[] = [scope.agencyId];
      const w = locationWhere(f, args);
      const r = await this.db.query(
        `select i.id, i.type, i.state, i.created_at, i.report_count, l.postcode, st_y(i.geom::geometry) as lat, st_x(i.geom::geometry) as lng, s.name as station, a.name as agency,
                (select u.display_name from incident_units x join users u on u.id = x.officer_id where x.incident_id = i.id and x.state in ('offered', 'accepted', 'en_route', 'on_scene') order by x.offered_at desc limit 1) as officer
           from incidents i left join locations l on l.id = i.location_id left join stations s on s.id = i.station_id left join agencies a on a.id = i.agency_id
          where i.state in ${OPEN} and ($1::uuid is null or i.agency_id = $1) and ${w} order by i.created_at desc`,
        args,
      );
      for (const i of r.rows) {
        items.push({
          id: i.id,
          kind: 'emergency',
          label: `${cap(i.type)}, ${i.postcode ?? 'GPS'}`,
          state: i.state,
          lat: i.lat,
          lng: i.lng,
          at: i.created_at,
          line: `${i.agency ?? 'No agency yet'}${i.station ? `, ${i.station}` : ''} · ${i.officer ?? 'no unit yet'}`,
          reports: i.report_count,
          href: `/incidents/${i.id}`,
        });
      }
    }
    if (want.has('tip')) {
      const args: unknown[] = [scope.agencyId];
      const w = locationWhere(f, args);
      const r = await this.db.query(
        `select t.id, t.public_no, t.category, t.state, t.created_at, l.postcode, st_y(l.geom::geometry) as lat, st_x(l.geom::geometry) as lng, a.name as agency
           from tips t join locations l on l.id = t.location_id left join agencies a on a.id = t.agency_id
          where t.state in ('sent', 'in_queue', 'more_info', 'claim_review') and ($1::uuid is null or t.agency_id = $1) and ${w} order by t.created_at desc limit 300`,
        args,
      );
      for (const t of r.rows) {
        items.push({ id: t.id, kind: 'tip', label: `Tip ${t.public_no}`, state: t.state, lat: t.lat, lng: t.lng, at: t.created_at, line: `${cap(t.category.replace(/_/g, ' '))} · ${t.agency ?? 'Not routed'}`, reports: 1, href: `/agency/tips/${t.id}` });
      }
    }
    if (want.has('issue')) {
      const args: unknown[] = [scope.agencyId];
      const w = locationWhere(f, args);
      const r = await this.db.query(
        `select k.id, k.public_no, k.category, k.state, k.severity, k.report_count, k.first_at, k.agency_label, l.postcode, st_y(k.geom::geometry) as lat, st_x(k.geom::geometry) as lng
           from issue_cases k left join locations l on l.id = k.location_id
          where k.state <> 'fixed' and ($1::uuid is null or k.agency_id = $1) and ${w} order by k.last_at desc limit 300`,
        args,
      );
      for (const k of r.rows) {
        items.push({
          id: k.id,
          kind: 'issue',
          label: `${cap(k.category.replace(/_/g, ' '))}, ${k.postcode ?? k.public_no}`,
          state: k.state,
          lat: k.lat,
          lng: k.lng,
          at: k.first_at,
          line: `${k.agency_label} · ${k.severity} · ${k.report_count} ${k.report_count === 1 ? 'report' : 'reports'}`,
          reports: k.report_count,
          href: `/agency/issues/${k.id}`,
        });
      }
    }
    const ua: unknown[] = [scope.agencyId];
    const units = await this.db.query(
      `select o.user_id as id, u.display_name as name, st_y(o.last_location::geometry) as lat, st_x(o.last_location::geometry) as lng, s.name as station,
              exists (select 1 from incident_units x where x.officer_id = o.user_id and x.state in ('accepted', 'en_route', 'on_scene')) as busy
         from officers o join users u on u.id = o.user_id join stations s on s.id = o.station_id
        where o.on_duty and o.last_location is not null and ($1::uuid is null or s.agency_id = $1)`,
      ua,
    );
    return {
      counts: { emergency: items.filter((x) => x.kind === 'emergency').length, tip: items.filter((x) => x.kind === 'tip').length, issue: items.filter((x) => x.kind === 'issue').length },
      items,
      units: want.has('emergency') ? units.rows.map((u) => ({ id: u.id, name: u.name, lat: u.lat, lng: u.lng, station: u.station, status: u.busy ? 'busy' : 'available' })) : [],
    };
  }
}
