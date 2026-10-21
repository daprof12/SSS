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
    // Every officer on the report: the first unit, reinforcements and other agencies' units. A citizen
    // sees them once they have accepted; staff and officers also see who is being offered it.
    const states = reporter && !staff && !mine ? ['accepted', 'en_route', 'on_scene'] : ['accepted', 'en_route', 'on_scene', 'offered'];
    const rows = (
      await this.db.query(
        `select * from (
           select distinct on (x.officer_id) x.officer_id, x.state, x.role, x.offered_at, u.display_name as name, o.last_location_at,
                  st_y(o.last_location::geometry) as lat, st_x(o.last_location::geometry) as lng, a.name as agency
             from incident_units x join users u on u.id = x.officer_id join officers o on o.user_id = x.officer_id
             left join stations s on s.id = x.station_id left join agencies a on a.id = s.agency_id
            where x.incident_id = $1 and x.officer_id is not null
            order by x.officer_id, x.offered_at desc) t
          where t.state = any($2::text[])
          order by case t.state when 'on_scene' then 0 when 'en_route' then 1 when 'accepted' then 2 else 3 end, t.offered_at`,
        [id, states],
      )
    ).rows;

    // You route from your phone position (else your last known one); everyone else from where they last were.
    if (mine && !you) {
      const last = (await this.db.query(`select st_y(last_location::geometry) as lat, st_x(last_location::geometry) as lng from officers where user_id = $1 and last_location is not null`, [p.userId])).rows[0];
      if (last) you = { lat: Number(last.lat), lng: Number(last.lng) };
    }
    const closed = ['on_scene', 'closing', 'resolved', 'unfounded', 'cancelled', 'merged'].includes(i.state);
    const units = await Promise.all(
      rows.map(async (u) => {
        const isYou = u.officer_id === p.userId;
        const at: LatLng | null = isYou && you ? you : u.lat != null ? { lat: Number(u.lat), lng: Number(u.lng) } : null;
        const route = at && !closed && u.state !== 'on_scene' ? await this.routing.route(at, incident) : null;
        return {
          id: u.officer_id as string,
          name: u.name as string,
          agency: (u.agency as string | null) ?? null,
          role: u.role as string,
          state: u.state as string,
          lat: at?.lat ?? null,
          lng: at?.lng ?? null,
          updatedAt: isYou && q.lat != null ? new Date().toISOString() : u.last_location_at,
          isYou,
          route,
        };
      }),
    );
    // Nearest first among those coming; those already there lead.
    units.sort((a, b) => (a.state === 'on_scene' ? -1 : 0) - (b.state === 'on_scene' ? -1 : 0) || (a.route?.durationS ?? 1e9) - (b.route?.durationS ?? 1e9));

    return {
      incident: { ...incident, type: i.type as string, label: `${cap(i.type)}, ${i.postcode ?? 'GPS location'}`, address: i.address_text, state: i.state },
      you,
      youDistanceM: you ? Math.round(metresBetween(you, incident)) : null,
      units,
    };
  }
}
