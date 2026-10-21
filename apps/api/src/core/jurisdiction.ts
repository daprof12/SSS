// Which station covers a place (Routing doc): a station whose areas (LGA, district or area) or
// drawn zone include it, else the nearest active station of that kind. Used for device alerts;
// incident routing ranks stations the same way in IncidentsService.rankStations.
import { dispatchingAgencyStates } from '@erp/domain';
import type { Queryable } from './db';

export interface CoveringStation {
  id: string;
  name: string;
  inArea: boolean;
}

export async function coveringStation(c: Queryable, locationId: string, kind = 'police'): Promise<CoveringStation | null> {
  const r = await c.query(
    `select s.id, s.name,
            coalesce(st_covers(s.zone, l.geom), false) or exists (
               select 1 from station_areas sa where sa.station_id = s.id
                  and ((sa.level = 'area' and sa.area_id = l.area_id) or (sa.level = 'district' and sa.area_id = l.district_id) or (sa.level = 'lga' and sa.area_id = l.lga_id))) as in_area
       from stations s
       join agencies a on a.id = s.agency_id and a.kind = $2 and a.status = any($3::text[])
       cross join (select * from locations where id = $1) l
       left join locations sl on sl.id = s.location_id
      where s.status = 'active'
      order by 3 desc, st_distance(coalesce(sl.geom, s.zone::geography), l.geom) nulls last
      limit 1`,
    [locationId, kind, dispatchingAgencyStates],
  );
  const s = r.rows[0];
  return s ? { id: s.id, name: s.name, inArea: s.in_area } : null;
}
