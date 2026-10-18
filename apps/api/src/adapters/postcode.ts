// NIPOST postcode adapter. The real per-level endpoints are not confirmed yet
// (TRD), so only this file changes when the API details arrive.

export interface Building {
  postcode: string;
  name?: string;
  address: string;
  stateId: string;
  lgaId: string;
  districtId: string;
  areaId: string;
  areaLabel: string;
  lat: number;
  lng: number;
}

export type Level = 'state' | 'lga' | 'district' | 'area' | 'building';

export interface PostcodeAdapter {
  lookup(postcode: string): Promise<Building | null>;
  nearest(lat: number, lng: number, radiusM?: number): Promise<Building | null>;
  /** Every building with a digital postcode within radiusM (NIPOST caps searches at 250 m), nearest first. */
  within(lat: number, lng: number, radiusM: number): Promise<Array<Building & { distanceM: number }>>;
  children(level: Level, parentId: string | null): Promise<Array<{ id: string; name: string }>>;
}

export const POSTCODE = Symbol('POSTCODE');

const SAMPLE: Building[] = [
  { postcode: 'AB12C', address: '12 Maple Road', stateId: 'LA', lgaId: 'LA-IKJ', districtId: 'LA-IKJ-01', areaId: 'LA-IKJ-01-MPL', areaLabel: 'Maple area, Ikeja', lat: 6.6018, lng: 3.3515 },
  { postcode: 'CD34E', address: '34 Allen Avenue', stateId: 'LA', lgaId: 'LA-IKJ', districtId: 'LA-IKJ-01', areaId: 'LA-IKJ-01-ALN', areaLabel: 'Allen, Ikeja', lat: 6.6012, lng: 3.3539 },
  { postcode: 'EF56G', address: '56 Herbert Macaulay Way', stateId: 'LA', lgaId: 'LA-YAB', districtId: 'LA-YAB-02', areaId: 'LA-YAB-02-HMW', areaLabel: 'Yaba central', lat: 6.5095, lng: 3.3711 },
  { postcode: 'GH78J', address: '78 Adeola Odeku Street', stateId: 'LA', lgaId: 'LA-ETI', districtId: 'LA-ETI-03', areaId: 'LA-ETI-03-VIS', areaLabel: 'Victoria Island', lat: 6.4311, lng: 3.4158 },
  { postcode: 'FC100', name: 'Station 4 Central', address: '1 Central Business District', stateId: 'FC', lgaId: 'FC-AMC', districtId: 'FC-AMC-01', areaId: 'FC-AMC-01-CBD', areaLabel: 'CBD, Abuja', lat: 9.0579, lng: 7.4951 },
];

const NAMES: Record<string, string> = {
  LA: 'Lagos', FC: 'FCT Abuja', 'LA-IKJ': 'Ikeja', 'LA-YAB': 'Yaba', 'LA-ETI': 'Eti-Osa', 'FC-AMC': 'Abuja Municipal',
  'LA-IKJ-01': 'Ikeja GRA', 'LA-YAB-02': 'Yaba', 'LA-ETI-03': 'Victoria Island', 'FC-AMC-01': 'Central',
};

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- Development buildings. NIPOST assigns a digital postcode to every building; the mock
// stands one up on most cells of a ~28 m grid around any point, so the picker works wherever
// it is tried. Postcodes encode their cell, so a lookup after a restart still resolves them.
const STEP = 0.00025;
const b36 = (n: number, w: number) => n.toString(36).toUpperCase().padStart(w, '0').slice(-w);
const hash = (i: number, j: number) => {
  let h = (i * 73856093) ^ (j * 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
};
const stateOf = (lat: number, lng: number) => (lat > 6.2 && lat < 6.8 && lng > 2.7 && lng < 4.4 ? 'LA' : lat > 8.8 && lat < 9.3 && lng > 7.1 && lng < 7.7 ? 'FC' : 'NG');

function devBuilding(i: number, j: number): Building | null {
  const h = hash(i, j);
  if (h % 10 >= 6) return null; // open ground, roads and yards between buildings
  const lat = (i + 0.2 + ((h >>> 4) % 60) / 100) * STEP;
  const lng = (j + 0.2 + ((h >>> 10) % 60) / 100) * STEP;
  const state = stateOf(lat, lng);
  const code = `${b36(i % 1296, 2)}${b36(j % 1296, 2)}`;
  let area = 'Near you';
  let best = 3000;
  for (const s of SAMPLE) {
    const d = metres(lat, lng, s.lat, s.lng);
    if (d < best) [area, best] = [s.areaLabel, d];
  }
  return {
    postcode: `${state}${b36(i, 4)}${b36(j, 4)}`,
    name: code,
    address: `Building ${code}`,
    stateId: state,
    lgaId: `${state}-DEV`,
    districtId: `${state}-DEV-${b36(Math.floor(i / 200), 2)}`,
    areaId: `${state}-DEV-${b36(Math.floor(i / 40), 3)}${b36(Math.floor(j / 40), 3)}`,
    areaLabel: area,
    lat,
    lng,
  };
}

function devLookup(pc: string): Building | null {
  const m = /^(LA|FC|NG)([0-9A-Z]{4})([0-9A-Z]{4})$/.exec(pc);
  if (!m) return null;
  const b = devBuilding(parseInt(m[2]!, 36), parseInt(m[3]!, 36));
  return b?.postcode === pc ? b : null;
}

export class MockPostcodeAdapter implements PostcodeAdapter {
  /** Set true to simulate "The address service is not responding." */
  down = false;

  private guard() {
    if (this.down) throw new PostcodeUnavailable();
  }

  async lookup(postcode: string) {
    this.guard();
    const pc = postcode.replace(/\s+/g, '').toUpperCase();
    return SAMPLE.find((b) => b.postcode === pc) ?? devLookup(pc);
  }

  async nearest(lat: number, lng: number, radiusM = 25) {
    return (await this.within(lat, lng, Math.min(radiusM, 250)))[0] ?? null;
  }

  async within(lat: number, lng: number, radiusM: number) {
    this.guard();
    const r = Math.min(Math.max(radiusM, 10), 250);
    const out: Array<Building & { distanceM: number }> = [];
    for (const b of SAMPLE) {
      const d = metres(lat, lng, b.lat, b.lng);
      if (d <= r) out.push({ ...b, distanceM: Math.round(d) });
    }
    const span = Math.ceil(r / 27) + 1;
    const ci = Math.floor(lat / STEP);
    const cj = Math.floor(lng / STEP);
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        const b = devBuilding(i, j);
        if (!b) continue;
        const d = metres(lat, lng, b.lat, b.lng);
        if (d <= r) out.push({ ...b, distanceM: Math.round(d) });
      }
    }
    return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, 60);
  }

  async children(level: Level, parentId: string | null) {
    this.guard();
    const key: Record<Level, keyof Building> = { state: 'stateId', lga: 'lgaId', district: 'districtId', area: 'areaId', building: 'postcode' };
    const parentKey: Record<Level, keyof Building | null> = { state: null, lga: 'stateId', district: 'lgaId', area: 'districtId', building: 'areaId' };
    const pk = parentKey[level];
    const rows = SAMPLE.filter((b) => !pk || b[pk] === parentId);
    const seen = new Map<string, string>();
    for (const b of rows) {
      const id = String(b[key[level]]);
      const name = level === 'building' ? `${b.address} (${b.postcode})` : level === 'area' ? b.areaLabel : NAMES[id] ?? id;
      seen.set(id, name);
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }
}

export class PostcodeUnavailable extends Error {
  constructor() {
    super('postcode service unavailable');
  }
}
