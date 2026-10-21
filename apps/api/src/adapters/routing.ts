// Road routes for the maps (TRD "maps and routing"): distance, driving time and the line to draw from
// a responder to the incident. Uses an OSRM server when one is configured; otherwise, or when it
// does not answer in time, a straight line with a city-driving estimate, marked as an estimate.

export interface LatLng {
  lat: number;
  lng: number;
}
export interface Route {
  distanceM: number;
  durationS: number;
  /** [lat, lng] points to draw. */
  line: [number, number][];
  source: 'road' | 'estimate';
}
export interface RoutingAdapter {
  readonly name: string;
  route(from: LatLng, to: LatLng): Promise<Route>;
}
export const ROUTING = Symbol('ROUTING');

/** Great-circle distance in metres. */
export function metresBetween(a: LatLng, b: LatLng) {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** No road data: the straight line, roads taken as 1.35 times longer, at 25 km/h in city traffic. */
export class EstimateRoutingAdapter implements RoutingAdapter {
  readonly name = 'estimate';
  async route(from: LatLng, to: LatLng): Promise<Route> {
    const road = metresBetween(from, to) * 1.35;
    return { distanceM: Math.round(road), durationS: Math.max(30, Math.round(road / (25_000 / 3600))), line: [[from.lat, from.lng], [to.lat, to.lng]], source: 'estimate' };
  }
}

/**
 * OSRM (`/route/v1/driving`). Only coordinates are sent, never who is travelling or why. Answers are
 * cached for 30 seconds by rounded position, so a map that refreshes does not ask again.
 */
export class OsrmRoutingAdapter implements RoutingAdapter {
  readonly name = 'osrm';
  private readonly cache = new Map<string, { at: number; route: Route }>();
  private readonly fallback = new EstimateRoutingAdapter();
  constructor(private readonly baseUrl: string) {}

  async route(from: LatLng, to: LatLng): Promise<Route> {
    const key = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(4)).join(',');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.route;
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'ERP-Nigeria/1.0' } });
      if (!res.ok) throw new Error(`routing ${res.status}`);
      const body = (await res.json()) as { code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] };
      const r = body.routes?.[0];
      if (body.code !== 'Ok' || !r) throw new Error(`routing ${body.code}`);
      const route: Route = {
        distanceM: Math.round(r.distance),
        durationS: Math.round(r.duration),
        line: r.geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]),
        source: 'road',
      };
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(key, { at: Date.now(), route });
      return route;
    } catch {
      return this.fallback.route(from, to);
    }
  }
}

/**
 * Production uses ROUTING_URL (your own OSRM server). Development uses the public OSRM demo server
 * unless ROUTING_URL=off. Tests always use the estimate, so they never call out.
 */
export function routingFromEnv(env: string, url: string | undefined): RoutingAdapter {
  if (env === 'test' || url === 'off') return new EstimateRoutingAdapter();
  if (url) return new OsrmRoutingAdapter(url);
  return env === 'production' ? new EstimateRoutingAdapter() : new OsrmRoutingAdapter('https://router.project-osrm.org');
}
