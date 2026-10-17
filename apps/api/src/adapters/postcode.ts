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

export class MockPostcodeAdapter implements PostcodeAdapter {
  /** Set true to simulate "The address service is not responding." */
  down = false;

  private guard() {
    if (this.down) throw new PostcodeUnavailable();
  }

  async lookup(postcode: string) {
    this.guard();
    const pc = postcode.replace(/\s+/g, '').toUpperCase();
    return SAMPLE.find((b) => b.postcode === pc) ?? null;
  }

  async nearest(lat: number, lng: number, radiusM = 25) {
    this.guard();
    const cap = Math.min(radiusM, 250); // NIPOST nearest search caps at 250 m
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of SAMPLE) {
      const d = metres(lat, lng, b.lat, b.lng);
      if (d <= cap && d < bestD) [best, bestD] = [b, d];
    }
    return best;
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
