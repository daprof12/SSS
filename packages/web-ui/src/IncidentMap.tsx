'use client';
// Live map of one report (GET /incidents/:id/map): the street map, plus how far and how long for
// every officer on it. A citizen sees how close help is; an officer sees how far they are from the
// report, to decide on an offer or to get there, and where the other units are. Refreshes every few seconds with the latest positions.
import { useEffect, useState } from 'react';
import { api } from './api';
import { StreetMap, unitColours, type MapPoint } from './StreetMap';

interface MapView {
  incident: MapPoint & { type: string; label: string; address: string | null; state: string };
  you: MapPoint | null;
  youDistanceM: number | null;
  units: Unit[];
}
interface Unit {
  id: string;
  name: string;
  agency: string | null;
  role: string;
  state: string;
  lat: number | null;
  lng: number | null;
  updatedAt: string | null;
  isYou: boolean;
  route: { distanceM: number; durationS: number; line: [number, number][]; source: 'road' | 'estimate' } | null;
}
const STATE: Record<string, string> = { offered: 'Being offered it', accepted: 'Accepted', en_route: 'On the way', on_scene: 'At the report' };
const ROLE: Record<string, string> = { reinforcement: 'Second unit', parallel: 'Other agency', transfer: 'Took over' };

export const distance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);
export const driveTime = (s: number) => {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
const ago = (iso: string | null) => {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function IncidentMap({
  incidentId,
  perspective,
  getPosition,
  height = 260,
  refreshMs = 10_000,
}: {
  incidentId: string;
  perspective: 'citizen' | 'officer' | 'staff';
  /** The device position, if it may be read (officers, and citizens who share it). */
  getPosition?: () => Promise<MapPoint | null>;
  height?: number;
  refreshMs?: number;
}) {
  const [v, setV] = useState<MapView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const pos = getPosition ? await getPosition().catch(() => null) : null;
      const q = pos ? `?lat=${pos.lat.toFixed(6)}&lng=${pos.lng.toFixed(6)}` : '';
      try {
        const next = await api<MapView>(`/incidents/${incidentId}/map${q}`);
        if (live) (setV(next), setFailed(false));
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, refreshMs);
    return () => ((live = false), clearInterval(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, refreshMs]);

  if (!v) {
    return failed ? (
      <div className="card" style={{ padding: 16 }}>
        <span className="muted">The map could not load. It will try again.</span>
      </div>
    ) : (
      <div className="skeleton" style={{ height, borderRadius: 16 }} />
    );
  }
  const units = v.units;
  const colours = unitColours(units);
  const mine = units.find((u) => u.isYou);
  const here = units.filter((u) => !u.isYou && u.state === 'on_scene');
  const coming = units.filter((u) => !u.isYou && u.state !== 'on_scene' && u.state !== 'offered' && u.route);
  const offered = units.filter((u) => !u.isYou && u.state === 'offered');
  const away = (u: Unit) => `${distance(u.route!.distanceM)} away, about ${driveTime(u.route!.durationS)}`;
  let headline: string;
  if (perspective === 'officer') {
    if (mine?.state === 'on_scene') headline = 'You are at the report';
    else if (mine?.route) headline = `You are ${distance(mine.route.distanceM)} away, about ${driveTime(mine.route.durationS)} drive`;
    else headline = 'Turn on location to see how far you are';
  } else if (here.length) {
    headline = `${here[0]!.name} ${here.length > 1 ? `and ${here.length - 1} more are` : 'is'} at the report`;
  } else if (coming.length) {
    headline = perspective === 'citizen' ? `Help is ${away(coming[0]!)}` : `${coming[0]!.name} is ${away(coming[0]!)}`;
  } else if (offered.length) {
    headline = `Offered to ${offered[0]!.name}, waiting for an answer`;
  } else {
    headline = perspective === 'citizen' ? 'Finding the nearest officer' : 'No officer on the way yet';
  }
  const sub =
    perspective === 'citizen' && coming.length
      ? coming.length === 1
        ? `${coming[0]!.name} is on the way`
        : `${coming.length} officers are on the way`
      : null;
  const estimate = units.some((u) => u.route?.source === 'estimate');
  // The list shows when there is more than the headline says: several officers, or anyone besides you.
  const list = units.filter((u) => !u.isYou || units.length > 1);
  const showList = list.length > 1 || (perspective === 'officer' && list.some((u) => !u.isYou));
  const row = (u: Unit) => {
    const seen = u.isYou ? null : ago(u.updatedAt);
    const where = u.state === 'on_scene' ? 'At the report' : u.route ? away(u) : 'Position not known yet';
    const meta = [ROLE[u.role], u.agency, STATE[u.state] ?? u.state, seen && `seen ${seen}`].filter(Boolean).join(' · ');
    return (
      <li key={u.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--color-divider, #333)' }}>
        <i aria-hidden style={{ width: 12, height: 12, borderRadius: '50%', background: colours[u.id], marginTop: 5, flex: 'none' }} />
        <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <strong>
            {u.isYou ? 'You' : u.name}: {where}
          </strong>
          <span className="muted" style={{ fontSize: 'var(--text-sm, 0.875rem)' }}>
            {meta}
          </span>
        </span>
      </li>
    );
  };
  return (
    <div className="ui-incident-map" style={{ display: 'grid', gap: 8 }}>
      <StreetMap
        incident={v.incident}
        you={v.you}
        units={units.map((u) => ({ id: u.id, name: u.name, lat: u.lat, lng: u.lng, isYou: u.isYou, line: u.route?.line, estimate: u.route?.source === 'estimate' }))}
        height={height}
        label={`Map: ${v.incident.label}. ${headline}.`}
      />
      <div aria-live="polite" style={{ display: 'grid', gap: 2 }}>
        <strong>{headline}</strong>
        {sub && <span className="muted">{sub}</span>}
        {units.some((u) => u.route) && (
          <span className="muted" style={{ fontSize: 'var(--text-sm, 0.875rem)' }}>
            {estimate ? 'Dashed lines are straight-line estimates; roads not known.' : 'Road routes, updated every few seconds.'}
          </span>
        )}
      </div>
      {showList && (
        <ul aria-label="Officers on this report" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {list.map(row)}
        </ul>
      )}
    </div>
  );
}
