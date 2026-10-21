'use client';
// Street map for one report: the report point, where you are, every officer on it, and each one's
// route line to the report. Street tiles, zoom buttons, drag to pan, and "fit" to
// bring everything back into view. Works with a mouse and a finger.
import { useEffect, useRef, useState } from 'react';
import { TYPE_COLOURS, TYPE_GLYPHS } from './typeGlyphs';

export interface MapPoint {
  lat: number;
  lng: number;
}

// Street tiles until a maps provider is chosen (TRD "maps and routing"); swap with an env var.
const TILE_URL = process.env.NEXT_PUBLIC_TILES_MAP ?? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const CREDIT = '© Esri, HERE, Garmin, OpenStreetMap contributors';
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

export interface MapUnit {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  isYou?: boolean;
  /** [lat, lng] points of the route to the report. */
  line?: [number, number][] | null;
  /** The route is a straight-line estimate, not a road route (drawn dashed). */
  estimate?: boolean;
}
/** One colour per officer, in list order, so a marker, its route and its row match. */
export const UNIT_COLOURS = ['#16a34a', '#9333ea', '#0891b2', '#c2410c', '#be185d', '#4d7c0f'];
export const YOU_COLOUR = '#1d72f3';
/** Colour per unit id: "you" is always blue; the others take the palette in order. */
export function unitColours(units: { id: string; isYou?: boolean }[]) {
  const out: Record<string, string> = {};
  let n = 0;
  for (const u of units) out[u.id] = u.isYou ? YOU_COLOUR : UNIT_COLOURS[n++ % UNIT_COLOURS.length]!;
  return out;
}

export function StreetMap({
  incident,
  you,
  units = [],
  height = 260,
  label,
}: {
  /** `type` is the report type code (fire, medical, ...): the pin shows its icon and colour. */
  incident: MapPoint & { label?: string; type?: string };
  you?: MapPoint | null;
  /** Officers on the report, each with its route to the report. Yours is drawn from the "You" dot. */
  units?: MapUnit[];
  height?: number;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  const [view, setView] = useState<{ lat: number; lng: number; z: number } | null>(null);
  const drag = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null);
  const touched = useRef(false);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.round(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const placed = units.filter((u): u is MapUnit & MapPoint => u.lat != null && u.lng != null);
  const colours = unitColours(units);
  const pts: MapPoint[] = [incident, ...(you ? [you] : []), ...placed, ...placed.flatMap((u) => (u.line ?? []).map(([lat, lng]) => ({ lat, lng })))];
  const fitKey = pts.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|') + `|${w}|${height}`;
  const fit = () => {
    const lats = pts.map((p) => p.lat);
    const lngs = pts.map((p) => p.lng);
    const c = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 };
    let z = 17;
    for (; z > 3; z--) {
      const a = worldPx(Math.max(...lats), Math.min(...lngs), z);
      const b = worldPx(Math.min(...lats), Math.max(...lngs), z);
      if (b.x - a.x < w * 0.75 && b.y - a.y < height * 0.7) break;
    }
    setView({ ...c, z });
  };
  // Keep everything in view as positions update, until the person moves the map themselves.
  useEffect(() => {
    if (!touched.current) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  if (!view) return <div ref={box} className="ui-street-map" style={{ height }} />;
  const c = worldPx(view.lat, view.lng, view.z);
  const left = c.x - w / 2;
  const top = c.y - height / 2;
  const at = (p: MapPoint) => {
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
    setView((v) => (v ? { ...v, z: Math.max(3, Math.min(19, v.z + d)) } : v));
  };
  const inc = at(incident);
  const pin = TYPE_COLOURS[incident.type ?? ''] ?? '#dc2626';
  const me = you ? at(you) : null;
  const others = placed.filter((u) => !u.isYou);
  return (
    <div
      ref={box}
      className="ui-street-map"
      style={{ height }}
      role="img"
      aria-label={label ?? 'Map of the report'}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button,a')) return;
        drag.current = { x: e.clientX, y: e.clientY, lat: view.lat, lng: view.lng };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        touched.current = true;
        const o = worldPx(d.lat, d.lng, view.z);
        setView({ ...fromWorld(o.x - (e.clientX - d.x), o.y - (e.clientY - d.y), view.z), z: view.z });
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <style>{CSS}</style>
      {tiles.map((t) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={t.key} className="ui-tile" src={t.src} alt="" draggable={false} style={{ left: t.x, top: t.y }} />
      ))}
      <svg width={w} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
        {placed.map((u) => {
          const path = (u.line ?? []).map(([lat, lng]) => at({ lat, lng }));
          if (path.length < 2) return null;
          const pts = path.map((p) => `${p.x},${p.y}`).join(' ');
          return (
            <g key={`r-${u.id}`}>
              <polyline points={pts} fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={pts} fill="none" stroke={colours[u.id]} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={u.estimate ? '2 10' : undefined} />
            </g>
          );
        })}
        {me && (
          <g>
            <circle cx={me.x} cy={me.y} r="18" fill={YOU_COLOUR} fillOpacity="0.18" />
            <circle cx={me.x} cy={me.y} r="8" fill={YOU_COLOUR} stroke="#fff" strokeWidth="3" />
          </g>
        )}
        {others.map((u) => {
          const q = at(u);
          return (
            <g key={`u-${u.id}`}>
              <circle cx={q.x} cy={q.y} r="13" fill={colours[u.id]} stroke="#fff" strokeWidth="3" />
              <text x={q.x} y={q.y + 4.5} textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">
                {initial(u.name)}
              </text>
              <title>{u.name}</title>
            </g>
          );
        })}
        <g>
          <circle className="ui-pulse" cx={inc.x} cy={inc.y} r="24" fill={pin} fillOpacity="0.22" />
          <path d={`M${inc.x} ${inc.y} l-7 -10 a17 17 0 1 1 14 0 z`} fill={pin} stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
          <g transform={`translate(${inc.x - 9.6} ${inc.y - 34.6}) scale(0.8)`} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            {TYPE_GLYPHS[incident.type ?? ''] ?? TYPE_GLYPHS.other}
          </g>
        </g>
      </svg>
      <div className="ui-map-legend">
        <span>
          <i style={{ background: pin }} /> {incident.label?.split(',')[0] ?? 'Report'}
        </span>
        {you && (
          <span>
            <i style={{ background: YOU_COLOUR }} /> You
          </span>
        )}
        {others.slice(0, 3).map((u) => (
          <span key={`l-${u.id}`}>
            <i style={{ background: colours[u.id] }} /> {u.name}
          </span>
        ))}
        {others.length > 3 && <span>+{others.length - 3} more</span>}
      </div>
      <div className="ui-map-zoom">
        <button type="button" onClick={() => zoom(1)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoom(-1)} aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          onClick={() => {
            touched.current = false;
            fit();
          }}
          aria-label="Show everything"
          title="Show everything"
        >
          ⤢
        </button>
      </div>
      <span className="ui-map-credit">{CREDIT}</span>
    </div>
  );
}

/** First letter of the name after any rank (Insp., Sgt., ...), for the officer marker. */
const initial = (name: string) => (name.replace(/^(Insp\.|Sgt\.|Cpl\.|CSP|ASP|DSP|SP|ACF|FO|Dr\.?)\s+/, '')[0] ?? '?').toUpperCase();

const CSS = `
.ui-street-map{position:relative;overflow:hidden;border-radius:16px;border:1px solid var(--color-divider,#333);background:#dfe6ee;touch-action:none;cursor:grab;user-select:none}
.ui-street-map:active{cursor:grabbing}
.ui-tile{position:absolute;width:256px;height:256px;pointer-events:none}
@media (prefers-color-scheme:dark){:root:not([data-theme='light']) .ui-tile{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9)}:root:not([data-theme='light']) .ui-street-map{background:#1b2028}}
:root[data-theme='dark'] .ui-tile{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9)}
:root[data-theme='dark'] .ui-street-map{background:#1b2028}
.ui-map-zoom{position:absolute;right:8px;top:8px;display:grid;gap:4px}
.ui-map-zoom button{width:34px;height:34px;border-radius:10px;border:1px solid var(--color-divider,#333);background:var(--color-surface-raised,#1f2937);color:var(--color-text-primary,#fff);font-size:18px;font-weight:700;cursor:pointer}
.ui-map-legend{position:absolute;left:8px;top:8px;display:flex;gap:8px;flex-wrap:wrap;font-size:11px;font-weight:600}
.ui-map-legend span{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:999px;background:color-mix(in srgb,var(--color-surface-raised,#1f2937) 88%,transparent);color:var(--color-text-primary,#fff)}
.ui-map-legend i{width:9px;height:9px;border-radius:50%}
.ui-map-credit{position:absolute;right:6px;bottom:4px;font-size:9px;color:#555;background:rgba(255,255,255,.7);padding:1px 4px;border-radius:4px}
@media (prefers-reduced-motion:no-preference){.ui-pulse{animation:ui-pulse 1.8s ease-out infinite;transform-box:fill-box;transform-origin:center}}
[data-motion='reduced'] .ui-pulse{animation:none}
@keyframes ui-pulse{0%{transform:scale(.6);opacity:.9}100%{transform:scale(1.6);opacity:0}}
`;
