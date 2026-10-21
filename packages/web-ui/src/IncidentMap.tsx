'use client';
// Live map of one report (GET /incidents/:id/map): the street map, plus how far and how long. A
// citizen sees how close help is; an officer sees how far they are from the report, to decide on an
// offer or to get there. Refreshes every few seconds with the latest positions.
import { useEffect, useState } from 'react';
import { api } from './api';
import { StreetMap, type MapPoint } from './StreetMap';

interface MapView {
  incident: MapPoint & { label: string; address: string | null; state: string };
  you: MapPoint | null;
  youDistanceM: number | null;
  unit: (MapPoint & { name: string; state: string; updatedAt: string | null; isYou: boolean }) | null;
  route: { distanceM: number; durationS: number; line: [number, number][]; source: 'road' | 'estimate'; from: 'you' | 'unit' } | null;
}

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
  const r = v.route;
  const unitHere = v.unit && !v.unit.isYou && v.unit.state === 'on_scene';
  let headline: string;
  let sub: string | null = null;
  if (perspective === 'officer') {
    if (r) headline = `You are ${distance(r.distanceM)} away, about ${driveTime(r.durationS)} drive`;
    else if (v.unit?.isYou && v.unit.state === 'on_scene') headline = 'You are at the report';
    else headline = 'Turn on location to see how far you are';
  } else if (unitHere) {
    headline = `${v.unit!.name} is at the report`;
  } else if (r && v.unit) {
    headline = perspective === 'citizen' ? `Help is ${distance(r.distanceM)} away, about ${driveTime(r.durationS)}` : `${v.unit.name} is ${distance(r.distanceM)} away, about ${driveTime(r.durationS)}`;
    sub = perspective === 'citizen' ? `${v.unit.name} is on the way` : null;
  } else if (v.unit && v.unit.state === 'offered') {
    headline = `Offered to ${v.unit.name}, waiting for an answer`;
  } else {
    headline = perspective === 'citizen' ? 'Finding the nearest officer' : 'No officer on the way yet';
  }
  const seen = v.unit && !v.unit.isYou ? ago(v.unit.updatedAt) : null;
  const notes = [r ? (r.source === 'road' ? 'Road route' : 'Straight-line estimate, roads not known') : null, seen ? `position updated ${seen}` : null].filter(Boolean).join(', ');
  return (
    <div className="ui-incident-map" style={{ display: 'grid', gap: 8 }}>
      <StreetMap
        incident={v.incident}
        you={v.you}
        unit={v.unit}
        line={r?.line}
        estimate={r?.source === 'estimate'}
        height={height}
        label={`Map: ${v.incident.label}. ${headline}.`}
      />
      <div aria-live="polite" style={{ display: 'grid', gap: 2 }}>
        <strong>{headline}</strong>
        {sub && <span className="muted">{sub}</span>}
        {notes && (
          <span className="muted" style={{ fontSize: 'var(--text-sm, 0.875rem)' }}>
            {notes[0]!.toUpperCase() + notes.slice(1)}
          </span>
        )}
      </div>
    </div>
  );
}
