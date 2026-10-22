import { randomInt } from 'node:crypto';
import type { Queryable } from '../core/db';

/** Live agencies receive reports; overdue ones too — billing never stops a report reaching them. */
export const RECEIVING = ['live', 'overdue', 'offboarding'];

/**
 * The agency that receives a tip or public issue, and its station for the place. Agencies are tried
 * in the category's order of kinds; among agencies of one kind, the one with a station covering the
 * place wins (its areas, or its zone), then the one with the nearest station. Without a place, or
 * when the agency has no stations yet, there is no station.
 */
export async function receivingAgency(
  c: Queryable,
  kinds: string[],
  place: { locationId?: string | null; lat?: number | null; lng?: number | null } = {},
): Promise<{ id: string; name: string; stationId: string | null; stationName: string | null } | null> {
  if (!kinds.length) return null;
  const r = await c.query(
    `with place as (
       select * from (
         select 0 as k, l.geom, l.lga_id, l.district_id, l.area_id from locations l where l.id = $3::uuid
         union all
         select 1, st_setsrid(st_makepoint($5::float8, $4::float8), 4326)::geography, null::text, null::text, null::text where $4::float8 is not null and $5::float8 is not null
       ) x order by k limit 1
     )
     select a.id, a.name, s.id as station_id, s.name as station_name
       from agencies a
       left join lateral (
         select st.id, st.name,
                (coalesce(st_covers(st.zone, p.geom), false) or exists (
                   select 1 from station_areas sa where sa.station_id = st.id
                      and ((sa.level = 'area' and sa.area_id = p.area_id) or (sa.level = 'district' and sa.area_id = p.district_id) or (sa.level = 'lga' and sa.area_id = p.lga_id)))) as covers,
                st_distance(coalesce(st.zone::geometry, sl.geom::geometry)::geography, p.geom) as d
           from stations st left join locations sl on sl.id = st.location_id cross join place p
          where st.agency_id = a.id and st.status = 'active'
          order by covers desc, d nulls last limit 1
       ) s on true
      where a.kind = any($1::text[]) and a.status = any($2::text[])
      order by array_position($1::text[], a.kind), s.covers desc nulls last, s.d nulls last, a.created_at limit 1`,
    [kinds, RECEIVING, place.locationId ?? null, place.lat ?? null, place.lng ?? null],
  );
  const x = r.rows[0];
  return x ? { id: x.id, name: x.name, stationId: x.station_id ?? null, stationName: x.station_name ?? null } : null;
}

/** Short public reference people can read out on the phone, e.g. T-482913. */
export async function publicNo(c: Queryable, table: 'tips' | 'issue_cases', prefix: string): Promise<string> {
  for (;;) {
    const no = `${prefix}-${String(randomInt(100000, 1000000))}`;
    const hit = await c.query(`select 1 from ${table} where public_no = $1`, [no]);
    if (!hit.rowCount) return no;
  }
}

export async function notify(c: Queryable, userIds: string[], n: { type: string; grp: string; title: string; body: string; link: string }) {
  if (!userIds.length) return;
  await c.query(
    `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
     select u, $2, $3, 'in_app', $4, $5, $6 from unnest($1::uuid[]) as u`,
    [userIds, n.type, n.grp, n.title, n.body, n.link],
  );
}

export async function agencyStaff(c: Queryable, agencyId: string): Promise<string[]> {
  const r = await c.query(`select distinct user_id from user_roles where scope_type = 'agency' and scope_id = $1 and role in ('agency_admin', 'agency_finance')`, [agencyId]);
  return r.rows.map((x) => x.user_id);
}
