// Smart-device fleet and the control centre. A platform admin switches device access on for an agency
// when onboarding it and registers its devices; from then on that agency's heads, dispatchers and admins
// see them on a map, see the devices at a report, send them commands and watch their feeds.
import { Inject, Injectable } from '@nestjs/common';
import { Audit } from '../core/audit';
import { can, hasRole, requirePerm, type Principal } from '../core/auth';
import { Db, type Queryable } from '../core/db';
import { AppError } from '../core/http';

export const FLEET_TYPES = ['smart_pole', 'defence_drone', 'fire_drone', 'body_cam', 'sensor', 'camera'] as const;
export type FleetType = (typeof FLEET_TYPES)[number];
export const COMMANDS = ['deploy', 'recall', 'goto_scene', 'siren_on', 'siren_off', 'light_on', 'light_off', 'stream_start', 'stream_stop'] as const;
export type Command = (typeof COMMANDS)[number];

/** What each product can be told to do. */
const ALLOWED: Record<string, Command[]> = {
  smart_pole: ['deploy', 'recall', 'goto_scene', 'siren_on', 'siren_off', 'light_on', 'light_off', 'stream_start', 'stream_stop'],
  defence_drone: ['deploy', 'recall', 'goto_scene', 'siren_on', 'siren_off', 'stream_start', 'stream_stop'],
  fire_drone: ['deploy', 'recall', 'goto_scene', 'stream_start', 'stream_stop'],
  camera: ['stream_start', 'stream_stop'],
  sensor: ['siren_on', 'siren_off'],
  body_cam: ['stream_start', 'stream_stop'],
};
export const DEVICE_LABEL: Record<string, string> = {
  smart_pole: 'Smart street light',
  defence_drone: 'Defence drone',
  fire_drone: 'Fire-fighter drone',
  body_cam: 'Officer body cam',
  sensor: 'Security sensor and alarm',
  camera: 'Camera',
};
const SCENE_RADIUS_M = 600;

@Injectable()
export class FleetService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Audit) private readonly audit: Audit,
  ) {}

  /** Agencies this person may run devices for: those with device access switched on that they lead. Platform admins: all of them. */
  async scope(p: Principal): Promise<{ all: boolean; agencyIds: string[] }> {
    if (can(p, 'platform.devices') || can(p, 'platform.live')) return { all: true, agencyIds: [] };
    const agencyScopes = p.roles.filter((r) => r.role === 'agency_admin' && r.scopeId).map((r) => r.scopeId!);
    const stationScopes = p.roles.filter((r) => (r.role === 'head' || r.role === 'dispatcher') && r.scopeId).map((r) => r.scopeId!);
    if (!agencyScopes.length && !stationScopes.length) return { all: false, agencyIds: [] };
    const r = await this.db.query(
      `select a.id from agencies a where a.device_access and (a.id = any($1::uuid[]) or exists (select 1 from stations s where s.agency_id = a.id and s.id = any($2::uuid[])))`,
      [agencyScopes, stationScopes],
    );
    return { all: false, agencyIds: r.rows.map((x) => x.id as string) };
  }

  private async requireScope(p: Principal) {
    const s = await this.scope(p);
    if (!s.all && !s.agencyIds.length) throw new AppError(403, 'forbidden', 'Smart devices are not switched on for your agency. Ask a platform admin.');
    return s;
  }

  private row(d: Record<string, any>) {
    return {
      id: d.id as string,
      type: d.type as string,
      label: DEVICE_LABEL[d.type as string] ?? d.type,
      name: (d.name as string | null) ?? DEVICE_LABEL[d.type as string] ?? d.type,
      serial: d.serial as string,
      status: d.status as string,
      state: d.state as string,
      battery: d.battery_pct as number | null,
      lat: d.lat as number | null,
      lng: d.lng as number | null,
      agency: (d.agency as string | null) ?? null,
      station: (d.station as string | null) ?? null,
      officer: (d.officer as string | null) ?? null,
      lastSeen: d.last_seen as string | null,
      streamUrl: (d.stream_url as string | null) ?? null,
      streaming: !!(d.settings as { streaming?: boolean } | null)?.streaming,
      lit: !!d.boost_until && new Date(d.boost_until as string).getTime() > Date.now(),
      docked: (d.docked as string | null) ?? null,
      distanceM: d.distance_m != null ? Math.round(Number(d.distance_m)) : undefined,
      can: ALLOWED[d.type as string] ?? [],
    };
  }

  private static readonly SELECT = `select d.*, a.name as agency, s.name as station, ou.display_name as officer, dk.name as docked
      from devices d left join agencies a on a.id = d.agency_id left join stations s on s.id = d.station_id
      left join users ou on ou.id = d.officer_id left join devices dk on dk.linked_to = d.id`;

  /** Control centre: the agency's devices, its open reports and the latest commands. */
  async overview(p: Principal) {
    const s = await this.requireScope(p);
    const ids = s.all ? null : s.agencyIds;
    const devices = (
      await this.db.query(`${FleetService.SELECT} where d.agency_id is not null and ($1::uuid[] is null or d.agency_id = any($1::uuid[])) order by d.type, d.name`, [ids])
    ).rows.map((d) => this.row(d));
    const incidents = (
      await this.db.query(
        `select i.id, i.type, i.state, i.created_at, st_y(i.geom::geometry) as lat, st_x(i.geom::geometry) as lng, l.postcode, l.address_text, a.name as agency
           from incidents i left join locations l on l.id = i.location_id left join agencies a on a.id = i.agency_id
          where i.state in ('routing', 'offered', 'accepted', 'en_route', 'on_scene') and ($1::uuid[] is null or i.agency_id = any($1::uuid[]))
          order by i.created_at desc limit 30`,
        [ids],
      )
    ).rows;
    const commands = (
      await this.db.query(
        `select c.id, c.command, c.status, c.created_at, d.name, d.type, u.display_name as by from device_commands c join devices d on d.id = c.device_id join users u on u.id = c.issued_by
          where ($1::uuid[] is null or d.agency_id = any($1::uuid[])) order by c.created_at desc limit 12`,
        [ids],
      )
    ).rows;
    return {
      devices,
      stats: {
        total: devices.length,
        online: devices.filter((d) => d.status === 'online').length,
        drones: devices.filter((d) => d.type.endsWith('drone')).length,
        deployed: devices.filter((d) => d.state === 'deployed').length,
      },
      incidents: incidents.map((i) => ({ id: i.id, type: i.type, state: i.state, at: i.created_at, lat: Number(i.lat), lng: Number(i.lng), postcode: i.postcode, address: i.address_text, agency: i.agency })),
      commands: commands.map((c) => ({ id: c.id, command: c.command, status: c.status, at: c.created_at, device: c.name ?? DEVICE_LABEL[c.type], by: c.by })),
    };
  }

  /** One report as the control centre sees it: devices near the scene, drones that can reach it, officers with a body cam on it. */
  async scene(p: Principal, incidentId: string) {
    const s = await this.requireScope(p);
    const i = (
      await this.db.query(
        `select i.id, i.type, i.state, i.agency_id, st_y(i.geom::geometry) as lat, st_x(i.geom::geometry) as lng, l.postcode, l.address_text
           from incidents i left join locations l on l.id = i.location_id where i.id = $1`,
        [incidentId],
      )
    ).rows[0];
    if (!i || (!s.all && !s.agencyIds.includes(i.agency_id))) throw new AppError(404, 'not_found', 'This report could not be found.');
    const dist = `st_distancesphere(st_makepoint(d.lng, d.lat), (select geom::geometry from incidents where id = $1))`;
    const all = (
      await this.db.query(
        `select d.*, a.name as agency, s.name as station, ou.display_name as officer, dk.name as docked, ${dist} as distance_m
           from devices d left join agencies a on a.id = d.agency_id left join stations s on s.id = d.station_id left join users ou on ou.id = d.officer_id left join devices dk on dk.linked_to = d.id
          where d.agency_id = $2 and d.lat is not null order by distance_m`,
        [incidentId, i.agency_id],
      )
    ).rows.map((d) => this.row(d));
    const bodyCams = (
      await this.db.query(
        `select d.*, a.name as agency, s.name as station, ou.display_name as officer, null::text as docked
           from devices d join incident_units x on x.officer_id = d.officer_id and x.incident_id = $1 and x.state in ('accepted', 'en_route', 'on_scene')
           left join agencies a on a.id = d.agency_id left join stations s on s.id = d.station_id left join users ou on ou.id = d.officer_id
          where d.type = 'body_cam'`,
        [incidentId],
      )
    ).rows.map((d) => this.row(d));
    const here = all.filter((d) => d.type !== 'body_cam' && !d.type.endsWith('drone') && (d.distanceM ?? 1e9) <= SCENE_RADIUS_M);
    const drones = all.filter((d) => d.type.endsWith('drone') || d.type === 'smart_pole').filter((d) => d.can.includes('goto_scene'));
    const commands = (
      await this.db.query(`select c.command, c.status, c.created_at, d.name, u.display_name as by from device_commands c join devices d on d.id = c.device_id join users u on u.id = c.issued_by where c.incident_id = $1 order by c.created_at desc limit 10`, [incidentId])
    ).rows;
    return {
      incident: { id: i.id, type: i.type, state: i.state, lat: Number(i.lat), lng: Number(i.lng), postcode: i.postcode, address: i.address_text },
      nearby: here,
      drones,
      bodyCams,
      radiusM: SCENE_RADIUS_M,
      commands: commands.map((c) => ({ command: c.command, status: c.status, at: c.created_at, device: c.name, by: c.by })),
    };
  }

  /** Send a command. Development uses a simulated device: it answers at once and changes its state. */
  async command(p: Principal, deviceId: string, command: Command, incidentId?: string) {
    const s = await this.requireScope(p);
    return this.db.tx(async (c) => {
      const d = (await c.query(`select * from devices where id = $1 for update`, [deviceId])).rows[0];
      if (!d || !d.agency_id || (!s.all && !s.agencyIds.includes(d.agency_id))) throw new AppError(404, 'not_found', 'Device not found.');
      if (!(ALLOWED[d.type] ?? []).includes(command)) throw new AppError(422, 'not_supported', `${DEVICE_LABEL[d.type] ?? 'This device'} cannot do that.`);
      if (d.status === 'offline') throw new AppError(409, 'offline', 'This device is offline. Try again when it is back.');
      let at: { lat: number; lng: number } | null = null;
      if (command === 'goto_scene') {
        const i = incidentId ? (await c.query(`select agency_id, st_y(geom::geometry) as lat, st_x(geom::geometry) as lng from incidents where id = $1`, [incidentId])).rows[0] : null;
        if (!i || (!s.all && !s.agencyIds.includes(i.agency_id))) throw new AppError(422, 'validation_failed', 'Choose the report to send it to.');
        at = { lat: Number(i.lat), lng: Number(i.lng) };
      }
      // A drone docked on a smart pole is launched and recalled through the pole.
      const target = ['deploy', 'recall', 'goto_scene'].includes(command) && d.type === 'smart_pole' ? ((await this.dockedDrone(c, d.id)) ?? d) : d;
      await this.apply(c, target, command, at);
      await c.query(`insert into device_commands (device_id, agency_id, incident_id, issued_by, command, result) values ($1, $2, $3, $4, $5, $6)`, [d.id, d.agency_id, incidentId ?? null, p.userId, command, JSON.stringify({ simulated: true, target: target.id })]);
      await this.audit.write({ actorId: p.userId, actorRole: hasRole(p, 'agency_admin') ? 'agency_admin' : 'station_staff', action: `device.${command}`, entity: 'device', entityId: d.id, payload: { incidentId } }, c);
      const fresh = (await c.query(`${FleetService.SELECT} where d.id = $1`, [d.id])).rows[0];
      return { device: this.row(fresh), message: MESSAGE[command](target.name ?? DEVICE_LABEL[target.type]) };
    });
  }

  private async dockedDrone(c: Queryable, poleId: string) {
    return (await c.query(`select * from devices where linked_to = $1 and type like '%drone' limit 1`, [poleId])).rows[0] as Record<string, any> | undefined;
  }

  private async apply(c: Queryable, d: Record<string, any>, command: Command, at: { lat: number; lng: number } | null) {
    switch (command) {
      case 'deploy':
        return c.query(`update devices set state = 'deployed' where id = $1`, [d.id]);
      case 'goto_scene':
        return c.query(`update devices set state = 'deployed', lat = $2, lng = $3 where id = $1`, [d.id, at!.lat, at!.lng]);
      case 'recall':
        return c.query(`update devices set state = 'standby' where id = $1`, [d.id]);
      case 'siren_on':
        return c.query(`update devices set state = 'siren' where id = $1`, [d.id]);
      case 'siren_off':
        return c.query(`update devices set state = 'standby' where id = $1`, [d.id]);
      case 'light_on':
        return c.query(`update devices set boost_until = now() + interval '1 hour' where id = $1`, [d.id]);
      case 'light_off':
        return c.query(`update devices set boost_until = null where id = $1`, [d.id]);
      case 'stream_start':
        return c.query(`update devices set settings = settings || '{"streaming": true}' where id = $1`, [d.id]);
      case 'stream_stop':
        return c.query(`update devices set settings = settings || '{"streaming": false}' where id = $1`, [d.id]);
    }
  }

  // ---------------------------------------------------------------- platform admin

  async setAccess(p: Principal, agencyId: string, enabled: boolean) {
    requirePerm(p, 'platform.devices');
    return this.db.tx(async (c) => {
      const a = (await c.query(`update agencies set device_access = $2 where id = $1 returning name`, [agencyId, enabled])).rows[0];
      if (!a) throw new AppError(404, 'not_found', 'Agency not found.');
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: enabled ? 'agency.device_access_on' : 'agency.device_access_off', entity: 'agency', entityId: agencyId, payload: {} }, c);
      return { deviceAccess: enabled, message: enabled ? `${a.name} can now run smart devices.` : `${a.name} can no longer run smart devices.` };
    });
  }

  async register(p: Principal, b: { type: FleetType; serial: string; name?: string; agencyId: string; stationId?: string; officerId?: string; lat?: number; lng?: number; dockedOn?: string }) {
    requirePerm(p, 'platform.devices');
    return this.db.tx(async (c) => {
      const a = (await c.query(`select name, device_access from agencies where id = $1`, [b.agencyId])).rows[0];
      if (!a) throw new AppError(404, 'not_found', 'Agency not found.');
      if (!a.device_access) throw new AppError(409, 'no_access', `Switch on smart devices for ${a.name} first.`);
      if (b.type === 'body_cam' && !b.officerId) throw new AppError(422, 'validation_failed', 'Choose the officer who wears it.', { fields: [{ field: 'officerId', message: 'Choose an officer.' }] });
      const dup = (await c.query(`select 1 from devices where serial = $1`, [b.serial])).rowCount;
      if (dup) throw new AppError(409, 'duplicate', 'A device with this serial number is already registered.', { fields: [{ field: 'serial', message: 'Already registered.' }] });
      const r = await c.query(
        `insert into devices (type, serial, name, status, agency_id, station_id, officer_id, lat, lng, linked_to, last_seen, battery_pct) values ($1, $2, $3, 'online', $4, $5, $6, $7, $8, $9, now(), 100) returning id`,
        [b.type, b.serial.trim(), b.name?.trim() || null, b.agencyId, b.stationId ?? null, b.officerId ?? null, b.lat ?? null, b.lng ?? null, b.dockedOn ?? null],
      );
      await this.audit.write({ actorId: p.userId, actorRole: 'platform_admin', action: 'device.registered', entity: 'device', entityId: r.rows[0].id, payload: { type: b.type, agencyId: b.agencyId } }, c);
      return { id: r.rows[0].id as string, message: `${DEVICE_LABEL[b.type]} registered for ${a.name}.` };
    });
  }

  async fleet(p: Principal) {
    requirePerm(p, 'platform.devices');
    const devices = (await this.db.query(`${FleetService.SELECT} where d.agency_id is not null order by a.name, d.type, d.name`)).rows.map((d) => this.row(d));
    const agencies = (await this.db.query(`select id, name, device_access from agencies where status in ('live', 'setting_up', 'overdue') order by name`)).rows;
    return { devices, agencies: agencies.map((a) => ({ id: a.id, name: a.name, deviceAccess: a.device_access })), types: FLEET_TYPES.map((t) => ({ code: t, label: DEVICE_LABEL[t] })) };
  }
}

const MESSAGE: Record<Command, (n: string) => string> = {
  deploy: (n) => `${n} is launching.`,
  recall: (n) => `${n} is returning to its dock.`,
  goto_scene: (n) => `${n} is flying to the report.`,
  siren_on: (n) => `Siren on at ${n}.`,
  siren_off: (n) => `Siren off at ${n}.`,
  light_on: (n) => `${n} lit to full brightness for an hour.`,
  light_off: (n) => `${n} is back to normal.`,
  stream_start: (n) => `Live feed from ${n} is starting.`,
  stream_stop: (n) => `Live feed from ${n} stopped.`,
};
