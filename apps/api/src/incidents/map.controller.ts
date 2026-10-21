import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { metresBetween, ROUTING, type LatLng, type RoutingAdapter } from '../adapters/routing';
import { can, CurrentUser, hasRole, type Principal } from '../core/auth';
import { Db } from '../core/db';
import { AppError, ZodPipe } from '../core/http';

const Here = z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Map of a report for whoever may see it: the report point, where you are, the responding unit, and
 * the road route with distance and driving time. An officer sees the way from them to the report (to
 * decide on an offer, or to get there); everyone else sees the unit's way to the report (how close
 * help is). A citizen sees the unit only once it has accepted.
 */
@Controller('incidents/:id/map')
export class IncidentMapController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ROUTING) private readonly routing: RoutingAdapter,
  ) {}

  @Get()
  async map(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(Here)) q: z.infer<typeof Here>) {
    const i = (
      await this.db.query(
        `select i.id, i.type, i.state, i.reporter_id, i.station_id, i.agency_id, st_y(i.geom::geometry) as lat, st_x(i.geom::geometry) as lng, l.postcode, l.address_text
           from incidents i left join locations l on l.id = i.location_id where i.id = $1`,
        [id],
      )
    ).rows[0];
    if (!i) throw new AppError(404, 'not_found', 'This report could not be found.');
    const mine = (await this.db.query(`select state from incident_units where incident_id = $1 and officer_id = $2 order by offered_at desc limit 1`, [id, p.userId])).rows[0];
    const reporter = i.reporter_id === p.userId || !!(await this.db.query(`select 1 from incident_reports where incident_id = $1 and reporter_id = $2`, [id, p.userId])).rowCount;
    const staff =
      (i.station_id && (hasRole(p, 'head', i.station_id) || hasRole(p, 'dispatcher', i.station_id))) || (i.agency_id && hasRole(p, 'agency_admin', i.agency_id)) || can(p, 'platform.live');
    if (!mine && !reporter && !staff) throw new AppError(404, 'not_found', 'This report could not be found.');

    const incident: LatLng = { lat: Number(i.lat), lng: Number(i.lng) };
    let you: LatLng | null = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null;
    // The unit on its way (or there); for staff, the officer being offered it if nobody has accepted yet.
    const u = (
      await this.db.query(
        `select x.state, x.officer_id, u.display_name as name, o.last_location_at, st_y(o.last_location::geometry) as lat, st_x(o.last_location::geometry) as lng
           from incident_units x join users u on u.id = x.officer_id join officers o on o.user_id = x.officer_id
          where x.incident_id = $1 and x.state = any($2::text[]) and o.last_location is not null
          order by case x.state when 'on_scene' then 0 when 'en_route' then 1 when 'accepted' then 2 else 3 end, x.offered_at desc limit 1`,
        [id, reporter && !staff && !mine ? ['accepted', 'en_route', 'on_scene'] : ['accepted', 'en_route', 'on_scene', 'offered']],
      )
    ).rows[0];
    const unit = u ? { lat: Number(u.lat), lng: Number(u.lng), name: u.name as string, state: u.state as string, updatedAt: u.last_location_at, isYou: u.officer_id === p.userId } : null;

    // Officers route from themselves (the device position, else their last known one); others from the unit.
    let from: (LatLng & { who: 'you' | 'unit' }) | null = null;
    if (mine) {
      const last = (await this.db.query(`select st_y(last_location::geometry) as lat, st_x(last_location::geometry) as lng from officers where user_id = $1 and last_location is not null`, [p.userId])).rows[0];
      const pos = you ?? (last ? { lat: Number(last.lat), lng: Number(last.lng) } : null);
      if (pos) (from = { ...pos, who: 'you' }), (you = pos);
    } else if (unit && unit.state !== 'on_scene') from = { lat: unit.lat, lng: unit.lng, who: 'unit' };
    const route = from && !['on_scene', 'closing', 'resolved', 'unfounded', 'cancelled', 'merged'].includes(i.state) ? await this.routing.route(from, incident) : null;

    return {
      incident: { ...incident, label: `${cap(i.type)}, ${i.postcode ?? 'GPS location'}`, address: i.address_text, state: i.state },
      you,
      youDistanceM: you ? Math.round(metresBetween(you, incident)) : null,
      unit,
      route: route && from ? { ...route, from: from.who } : null,
    };
  }
}
