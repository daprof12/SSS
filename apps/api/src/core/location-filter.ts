// "Filter by location" (boards: Admin overview, Users, Subscriptions, live maps): the five NIPOST
// levels, state → LGA → district → area → building, or a typed postcode. The lists come from the
// postcode service (/places/levels); here each level is a column on `locations`.
import { z } from 'zod';

export const LocationQuery = z.object({
  state: z.string().max(40).optional(),
  lga: z.string().max(40).optional(),
  district: z.string().max(40).optional(),
  area: z.string().max(60).optional(),
  building: z.string().max(20).optional(),
  postcode: z.string().max(20).optional(),
});
export type LocationFilter = z.infer<typeof LocationQuery>;

/**
 * A SQL condition on the `locations` row aliased `l` (or another alias), appending its values to
 * `args`. The deepest level chosen wins; a typed postcode matches by prefix, spaces ignored.
 */
export function locationWhere(f: LocationFilter | undefined, args: unknown[], alias = 'l'): string {
  if (!f) return 'true';
  const parts: string[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    parts.push(sql.replace('$?', `$${args.length}`));
  };
  if (f.building) add(`${alias}.postcode = $?`, f.building);
  else if (f.area) add(`${alias}.area_id = $?`, f.area);
  else if (f.district) add(`${alias}.district_id = $?`, f.district);
  else if (f.lga) add(`${alias}.lga_id = $?`, f.lga);
  else if (f.state) add(`${alias}.state_id = $?`, f.state);
  if (f.postcode?.trim()) add(`replace(${alias}.postcode, ' ', '') ilike replace($?, ' ', '') || '%'`, f.postcode.trim());
  return parts.length ? parts.join(' and ') : 'true';
}

export const hasLocation = (f: LocationFilter | undefined) => !!f && !!(f.state || f.lga || f.district || f.area || f.building || f.postcode?.trim());
