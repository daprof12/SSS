'use client';
// Shared dashboard pieces: the zone map (boards "Station dashboard", "Station map", "Admin live
// incident map"), horizontal bar charts (Reports, Overview) and small formatters.
import { formatNaira } from '@erp/domain';
import Link from 'next/link';

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

/**
 * A schematic map: points placed by their real offsets from the centre on a street grid, no map tiles.
 * Square: the station. Large dot: an open report. Diamond: a unit. Small dot: a device (red = tamper).
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
  const W = 1000;
  const H = 620;
  const all = [...incidents, ...units, ...devices].filter((p) => p.lat != null && p.lng != null) as { lat: number; lng: number }[];
  // Fit the farthest point, but never zoom tighter than 600 m or wider than the zone.
  const far = Math.max(600, ...all.map((p) => dist(center, p)));
  const span = Math.min(Math.max(far * 1.25, 600), Math.max(radiusM * 1.1, far * 1.25));
  const scale = (Math.min(W, H) / 2) / span;
  const xy = (p: { lat: number; lng: number }) => {
    const dx = (p.lng - center.lng) * 111_320 * Math.cos((center.lat * Math.PI) / 180);
    const dy = (p.lat - center.lat) * 110_540;
    return { x: W / 2 + dx * scale, y: H / 2 - dy * scale };
  };
  const zoneR = radiusM * scale;
  const incColor = (i: MapIncident) => (i.state === 'escalated' ? 'var(--color-emergency)' : ['offered', 'received'].includes(i.state) ? 'var(--color-warning)' : (i.severity ?? 3) >= 4 ? 'var(--color-emergency)' : '#ff7a45');
  const devColor = (d: MapDevice) => (d.status === 'tamper' ? 'var(--color-emergency)' : d.status === 'online' ? 'var(--color-success)' : d.status === 'low_power' ? 'var(--color-warning)' : '#8a8f98');
  return (
    <svg className="zone-map" viewBox={`0 0 ${W} ${H}`} style={{ height }} role="img" aria-label={`Map: ${incidents.length} open reports, ${units.length} units, ${devices.length} devices`}>
      <defs>
        <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
          <path d="M 80 0 L 0 0 0 80" fill="none" stroke="var(--map-grid)" strokeWidth="2" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="var(--map-bg)" />
      <rect width={W} height={H} fill="url(#grid)" />
      <line x1="0" y1={H * 0.36} x2={W} y2={H * 0.36} stroke="var(--map-road)" strokeWidth="18" />
      <line x1={W * 0.3} y1="0" x2={W * 0.3} y2={H} stroke="var(--map-road)" strokeWidth="18" />
      <line x1="0" y1={H * 0.78} x2={W} y2={H * 0.62} stroke="var(--map-road)" strokeWidth="12" />
      {zoneR < W && <circle cx={W / 2} cy={H / 2} r={zoneR} fill="var(--color-signal-soft)" fillOpacity="0.25" stroke="var(--color-signal)" strokeDasharray="8 8" strokeOpacity="0.6" />}
      {showStation && <rect x={W / 2 - 16} y={H / 2 - 16} width="32" height="32" rx="6" fill="var(--color-signal)" />}
      {devices.filter((d) => d.lat != null).map((d) => {
        const p = xy(d as { lat: number; lng: number });
        return <circle key={d.id} cx={p.x} cy={p.y} r="9" fill={devColor(d)} stroke="var(--map-bg)" strokeWidth="3"><title>{`${d.type === 'camera' ? 'Camera' : 'Street light'}: ${d.status.replace('_', ' ')}`}</title></circle>;
      })}
      {incidents.filter((i) => i.lat != null).map((i) => {
        const p = xy(i as { lat: number; lng: number });
        const on = selected === i.id;
        const dot = (
          <g key={i.id} style={{ cursor: onSelect || link ? 'pointer' : 'default' }} onClick={() => onSelect?.(i.id)}>
            <circle cx={p.x} cy={p.y} r={on ? 34 : 28} fill={incColor(i)} fillOpacity="0.22" />
            <circle cx={p.x} cy={p.y} r="15" fill={incColor(i)} stroke="#fff" strokeWidth="3" />
            <g transform={`translate(${p.x + 24}, ${p.y - 16})`}>
              <rect width={i.label.length * 11 + 16} height="30" rx="8" fill="rgba(0,0,0,0.75)" />
              <text x="8" y="21" fill="#fff" fontSize="18" fontWeight="700">
                {i.label}
              </text>
            </g>
            <title>{`${i.label}: ${STATE_LABEL[i.state] ?? i.state}`}</title>
          </g>
        );
        return link ? (
          <Link key={i.id} href={link(i.id)}>
            {dot}
          </Link>
        ) : (
          dot
        );
      })}
      {units.filter((u) => u.lat != null).map((u) => {
        const p = xy(u as { lat: number; lng: number });
        return (
          <g key={u.id} transform={`translate(${p.x}, ${p.y}) rotate(45)`}>
            <rect x="-11" y="-11" width="22" height="22" rx="3" fill={u.status === 'available' ? 'var(--color-signal)' : u.status === 'off' ? '#8a8f98' : '#ffffff'} stroke="var(--color-signal)" strokeWidth="4" />
            <title>{`${u.name}: ${u.status.replace('_', ' ')}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function dist(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dx = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
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
