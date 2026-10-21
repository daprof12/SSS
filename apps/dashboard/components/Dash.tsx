'use client';
// Shared dashboard pieces: the zone map (boards "Station dashboard", "Station map", "Admin live
// incident map"), horizontal bar charts (Reports, Overview) and small formatters.
import { formatNaira } from '@erp/domain';
import { useEffect, useRef, useState } from 'react';

export const mmss = (s: number | null | undefined) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
export const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');
export const ago = (iso: string, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - +new Date(iso)) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
export const STATE_LABEL: Record<string, string> = {
  received: 'Received',
  offered: 'Offered',
  escalated: 'Escalated',
  accepted: 'Accepted',
  en_route: 'En route',
  reassigning: 'Reassigning',
  transferred: 'Transferred',
  on_scene: 'On scene',
  closing: 'Closing',
};
export const stateTone = (s: string) => (s === 'escalated' ? 'critical' : ['offered', 'reassigning', 'transferred', 'received'].includes(s) ? 'warning' : s === 'on_scene' ? 'success' : 'info');

interface Pt {
  lat: number | null;
  lng: number | null;
}
export interface MapIncident extends Pt {
  id: string;
  label: string;
  state: string;
  severity?: number;
  /** Marker colour; defaults by state (emergencies). Tips and public issues pass their own. */
  color?: string;
}
export interface MapUnit extends Pt {
  id: string;
  name: string;
  status: string;
}
export interface MapDevice extends Pt {
  id: string;
  type: string;
  status: string;
}

// Street tiles until a maps provider is chosen (TRD "maps and routing"); swap with an env var.
const TILE_URL = process.env.NEXT_PUBLIC_TILES_MAP ?? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const TILE_CREDIT = '© Esri, HERE, Garmin, OpenStreetMap contributors';
const worldPx = (lat: number, lng: number, z: number) => {
  const s = 256 * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
};
const fromWorld = (x: number, y: number, z: number) => {
  const s = 256 * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: (x / s) * 360 - 180 };
};
const metresPerPx = (lat: number, z: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * A street map: tiles, the station (square), open reports (large dots with labels), units (diamonds)
 * and devices (small dots, red = tamper), with zoom buttons and drag to pan. It fits everything on
 * first load and keeps the view once the person has moved it.
 */
export function ZoneMap({
  center,
  radiusM = 5000,
  incidents = [],
  units = [],
  devices = [],
  selected,
  onSelect,
  showStation = true,
  height = 420,
  link,
}: {
  center: { lat: number; lng: number };
  radiusM?: number;
  incidents?: MapIncident[];
  units?: MapUnit[];
  devices?: MapDevice[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  showStation?: boolean;
  height?: number;
  link?: (id: string) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [view, setView] = useState<{ lat: number; lng: number; z: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const drag = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null);
  const touched = useRef(false);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.round(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const pts = [...incidents, ...units, ...devices].filter((p) => p.lat != null && p.lng != null) as { lat: number; lng: number }[];
  const fitKey = pts.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|') + `|${center.lat},${center.lng}|${w}`;
  // Fit the points (and the zone, when drawn) until the person zooms or pans.
  useEffect(() => {
    if (touched.current) return;
    const all = [...pts, ...(showStation ? [center] : [])];
    if (!all.length) return setView({ ...center, z: 14 });
    const lats = all.map((p) => p.lat);
    const lngs = all.map((p) => p.lng);
    const c = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
    let z = 17;
    for (; z > 3; z--) {
      const a = worldPx(Math.max(...lats), Math.min(...lngs), z);
      const b = worldPx(Math.min(...lats), Math.max(...lngs), z);
      if (b.x - a.x < w * 0.8 && b.y - a.y < height * 0.75) break;
    }
    setView({ ...c, z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, height]);
  if (!view) return <div ref={box} className="street-map" style={{ height }} />;
  const c = worldPx(view.lat, view.lng, view.z);
  const left = c.x - w / 2;
  const top = c.y - height / 2;
  const at = (p: { lat: number; lng: number }) => {
    const q = worldPx(p.lat, p.lng, view.z);
    return { x: q.x - left, y: q.y - top };
  };
  const tiles: { key: string; x: number; y: number; src: string }[] = [];
  const n = 2 ** view.z;
  for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++) {
    for (let ty = Math.max(0, Math.floor(top / 256)); ty <= Math.min(n - 1, Math.floor((top + height) / 256)); ty++) {
      const wx = ((tx % n) + n) % n;
      tiles.push({ key: `${view.z}/${tx}/${ty}`, x: tx * 256 - left, y: ty * 256 - top, src: TILE_URL.replace('{z}', String(view.z)).replace('{x}', String(wx)).replace('{y}', String(ty)) });
    }
  }
  const zoom = (d: number) => {
    touched.current = true;
    setView((v) => (v ? { ...v, z: Math.max(3, Math.min(18, v.z + d)) } : v));
  };
  const zoneR = radiusM / metresPerPx(view.lat, view.z);
  const incColor = (i: MapIncident) => i.color ?? (i.state === 'escalated' ? 'var(--color-emergency)' : ['offered', 'received'].includes(i.state) ? 'var(--color-warning)' : (i.severity ?? 3) >= 4 ? 'var(--color-emergency)' : '#ff7a45');
  const devColor = (d: MapDevice) => (d.status === 'tamper' ? 'var(--color-emergency)' : d.status === 'online' ? 'var(--color-success)' : d.status === 'low_power' ? 'var(--color-warning)' : '#8a8f98');
  const st = at(center);
  return (
    <div
      ref={box}
      className="street-map"
      style={{ height }}
      role="img"
      aria-label={`Map: ${incidents.length} reports, ${units.length} units, ${devices.length} devices`}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('a,button,[data-pin]')) return;
        drag.current = { x: e.clientX, y: e.clientY, lat: view.lat, lng: view.lng };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        touched.current = true;
        const o = worldPx(d.lat, d.lng, view.z);
        const p = fromWorld(o.x - (e.clientX - d.x), o.y - (e.clientY - d.y), view.z);
        setView({ ...p, z: view.z });
      }}
      onPointerUp={() => (drag.current = null)}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoom(e.deltaY < 0 ? 1 : -1);
      }}
    >
      {tiles.map((t) => (
        <img key={t.key} className="tile" src={t.src} alt="" draggable={false} style={{ left: t.x, top: t.y }} onError={() => setBroken(true)} />
      ))}
      <svg width={w} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        {showStation && zoneR < w * 3 && <circle cx={st.x} cy={st.y} r={zoneR} fill="var(--color-signal)" fillOpacity="0.08" stroke="var(--color-signal)" strokeDasharray="8 8" strokeWidth="2" />}
        {showStation && <rect x={st.x - 11} y={st.y - 11} width="22" height="22" rx="5" fill="var(--color-signal)" stroke="#fff" strokeWidth="3" />}
        {devices.filter((d) => d.lat != null).map((d) => {
          const p = at(d as { lat: number; lng: number });
          return (
            <circle key={d.id} cx={p.x} cy={p.y} r="6" fill={devColor(d)} stroke="#fff" strokeWidth="2">
              <title>{`${d.type === 'camera' ? 'Camera' : 'Street light'}: ${d.status.replace('_', ' ')}`}</title>
            </circle>
          );
        })}
        {units.filter((u) => u.lat != null).map((u) => {
          const p = at(u as { lat: number; lng: number });
          return (
            <g key={u.id} transform={`translate(${p.x}, ${p.y}) rotate(45)`}>
              <rect x="-8" y="-8" width="16" height="16" rx="2" fill={u.status === 'available' ? 'var(--color-signal)' : u.status === 'off' ? '#8a8f98' : '#ffffff'} stroke="var(--color-signal)" strokeWidth="3" />
              <title>{`${u.name}: ${u.status.replace('_', ' ')}`}</title>
            </g>
          );
        })}
        {incidents.filter((i) => i.lat != null).map((i) => {
          const p = at(i as { lat: number; lng: number });
          const on = selected === i.id;
          const g = (
            <g key={i.id} data-pin style={{ cursor: onSelect || link ? 'pointer' : 'default' }} onClick={() => onSelect?.(i.id)}>
              <circle cx={p.x} cy={p.y} r={on ? 22 : 17} fill={incColor(i)} fillOpacity="0.25" />
              <circle cx={p.x} cy={p.y} r="9" fill={incColor(i)} stroke="#fff" strokeWidth="2.5" />
              <g transform={`translate(${p.x + 14}, ${p.y - 11})`}>
                <rect width={i.label.length * 6.6 + 12} height="22" rx="6" fill="rgba(0,0,0,0.75)" />
                <text x="6" y="15" fill="#fff" fontSize="12" fontWeight="700">
                  {i.label}
                </text>
              </g>
              <title>{`${i.label}: ${STATE_LABEL[i.state] ?? i.state}`}</title>
            </g>
          );
          return link ? (
            <a key={i.id} href={link(i.id)}>
              {g}
            </a>
          ) : (
            g
          );
        })}
      </svg>
      <div className="map-zoom">
        <button type="button" onClick={() => zoom(1)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoom(-1)} aria-label="Zoom out">
          −
        </button>
      </div>
      <span className="map-credit">{broken ? 'Map images could not load. The markers are still right.' : TILE_CREDIT}</span>
    </div>
  );
}

/** Labelled horizontal bars (board "Station reports"). */
export function HBars({ rows, color = 'var(--color-signal)', format = (v: number) => String(v) }: { rows: { label: string; value: number | null; color?: string }[]; color?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.label} className="hbar">
          <span>{r.label}</span>
          <span className="track">
            <i style={{ width: `${((r.value ?? 0) / max) * 100}%`, background: r.color ?? color }} />
          </span>
          <strong>{r.value == null ? '—' : format(r.value)}</strong>
        </div>
      ))}
    </div>
  );
}
