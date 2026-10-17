// Loads the full server-side incident record that projections filter.
import { Inject, Injectable } from '@nestjs/common';
import type { IncidentRecord, IncidentState, TimelineEntry } from '@erp/domain';
import { Db, type Queryable } from '../core/db';

export interface IncidentRow {
  id: string;
  reporter_id: string;
  type: string;
  state: IncidentState;
  station_id: string | null;
  agency_id: string | null;
  merged_into: string | null;
  version: number;
  received_at: Date | null;
  discreet: boolean;
  lat: number;
  lng: number;
}

const ACTIVE_UNIT = `('offered', 'accepted', 'en_route', 'on_scene')`;

@Injectable()
export class IncidentRepo {
  constructor(@Inject(Db) private readonly db: Db) {}

  async row(id: string, c: Queryable = this.db.pool, lock = false): Promise<IncidentRow | null> {
    const r = await c.query<IncidentRow>(
      `select id, reporter_id, type, state, station_id, agency_id, merged_into, version, received_at, discreet,
              st_y(geom::geometry) as lat, st_x(geom::geometry) as lng
         from incidents where id = $1 ${lock ? 'for update' : ''}`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async unitFor(incidentId: string, officerId: string, c: Queryable = this.db.pool) {
    const r = await c.query(
      `select * from incident_units where incident_id = $1 and officer_id = $2 and state in ${ACTIVE_UNIT} order by offered_at desc limit 1`,
      [incidentId, officerId],
    );
    return r.rows[0] ?? null;
  }

  async record(id: string): Promise<IncidentRecord | null> {
    const q = await this.db.query(
      `select i.*, st_y(i.geom::geometry) as lat, st_x(i.geom::geometry) as lng,
              u.display_name as reporter_name, u.phone as reporter_phone,
              coalesce(t.score, 70) as trust_score, coalesce(t.band, 'normal') as trust_band,
              l.postcode, l.address_text, l.area_label, st_y(l.geom::geometry) as b_lat, st_x(l.geom::geometry) as b_lng
         from incidents i
         join users u on u.id = i.reporter_id
         left join trust_scores t on t.user_id = i.reporter_id
         left join locations l on l.id = i.location_id
        where i.id = $1`,
      [id],
    );
    const i = q.rows[0];
    if (!i) return null;

    const [units, joiners, events, rating] = await Promise.all([
      this.db.query(
        `select iu.officer_id, iu.state, ou.display_name, o.badge_no, s.name as station_name,
                st_y(o.last_location::geometry) as o_lat, st_x(o.last_location::geometry) as o_lng,
                (select round(avg(r.stars)::numeric, 1) from ratings r join incident_units x on x.incident_id = r.incident_id where x.officer_id = iu.officer_id) as rating
           from incident_units iu
           join stations s on s.id = iu.station_id
           left join officers o on o.user_id = iu.officer_id
           left join users ou on ou.id = iu.officer_id
          where iu.incident_id = $1 and iu.state in ${ACTIVE_UNIT}
          order by case iu.state when 'on_scene' then 0 when 'en_route' then 1 when 'accepted' then 2 else 3 end, iu.offered_at`,
        [id],
      ),
      this.db.query(`select distinct reporter_id from incident_reports where incident_id = $1 and role = 'joined' and reporter_id is not null`, [id]),
      this.db.query(`select id, kind, to_state, payload, public, actor_id, at from incident_events where incident_id = $1 order by id`, [id]),
      this.db.query(`select stars, comment from ratings where incident_id = $1 and reporter_id = $2`, [id, i.reporter_id]),
    ]);

    const lead = units.rows.find((u) => u.state !== 'offered');
    const timeline: TimelineEntry[] = events.rows.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind,
      label: e.payload?.label ?? e.kind,
      public: e.public,
    }));

    const building = i.postcode
      ? { postcode: i.postcode, address: i.address_text, areaLabel: i.area_label, location: { lat: i.b_lat, lng: i.b_lng } }
      : { postcode: '', address: 'Location from GPS', areaLabel: 'Near your location', location: { lat: i.lat, lng: i.lng } };

    return {
      id: i.id,
      type: i.type,
      state: i.state,
      agencyId: i.agency_id ?? '',
      stationId: i.station_id ?? undefined,
      reporter: { userId: i.reporter_id, name: i.reporter_name, phone: i.reporter_phone ?? '', trustScore: Number(i.trust_score), trustBand: i.trust_band },
      joinerUserIds: joiners.rows.map((r) => r.reporter_id),
      reportCount: i.report_count,
      building,
      reporterGps: { lat: i.lat, lng: i.lng },
      assignedOfficerIds: units.rows.map((u) => u.officer_id).filter(Boolean),
      officer: lead && {
        id: lead.officer_id,
        name: lead.display_name,
        badgeNo: lead.badge_no,
        stationName: lead.station_name,
        rating: lead.rating ? Number(lead.rating) : 0,
        location: lead.o_lat != null ? { lat: lead.o_lat, lng: lead.o_lng } : undefined,
      },
      etaMinutes: i.eta_minutes ?? undefined,
      brief: undefined,
      clipIds: [],
      timeline,
      notes: events.rows
        .filter((e) => e.kind === 'note')
        .map((e) => ({ by: e.actor_id, text: e.payload?.text ?? '', at: e.at.toISOString() })),
      rating: rating.rows[0] ? { stars: rating.rows[0].stars, comment: rating.rows[0].comment ?? undefined } : undefined,
      mergedInto: i.merged_into ?? undefined,
      createdAt: i.created_at.toISOString(),
      updatedAt: i.updated_at.toISOString(),
    };
  }
}
