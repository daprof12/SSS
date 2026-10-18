'use client';
// "Pick your building": the user's location on a satellite map, every building's NIPOST
// digital postcode around it, and a search radius they can widen. Tapping a building picks
// its postcode, so nobody has to type one. Tapping open ground moves the search there.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/Icon';
import { api, ApiError, haptic, locate } from '@/lib/client';

export interface PickedBuilding {
  postcode: string;
  label: string;
  address: string;
  area: string;
  lat: number;
  lng: number;
  distanceM: number;
}
type Spot = { lat: number; lng: number; accuracy?: number };
type Layer = 'satellite' | 'map';

// Esri tiles until a maps provider is chosen (TRD "maps and routing"); swap with env vars.
const TILES: Record<Layer, { url: string; credit: string }> = {
  satellite: {
    url: process.env.NEXT_PUBLIC_TILES_SATELLITE ?? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
  map: {
    url: process.env.NEXT_PUBLIC_TILES_MAP ?? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    credit: '© Esri, HERE, Garmin, OpenStreetMap contributors',
  },
};
const MIN_R = 25;
const MAX_R = 250; // NIPOST searches cap at 250 m

/** NIPOST-style grouping for reading aloud: "LA KDC0 AEC0". */
export const formatPostcode = (pc: string) => (/^[A-Z]{2}[0-9A-Z]{8}$/.test(pc) ? `${pc.slice(0, 2)} ${pc.slice(2, 6)} ${pc.slice(6)}` : pc);

// ---- Web Mercator: world pixels at a zoom level (256 px tiles).
const worldPx = (lat: number, lng: number, z: number) => {
  const s = 256 * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
};
const fromWorld = (x: number, y: number, z: number) => {
  const s = 256 * 2 ** z;
  const lng = (x / s) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / s;
  return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng };
};
const metresPerPx = (lat: number, z: number) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 360, h: 320 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function TileMap({
  center,
  you,
  radiusM,
  buildings,
  selected,
  layer,
  onPick,
  onMove,
}: {
  center: Spot;
  you: Spot | null;
  radiusM: number;
  buildings: PickedBuilding[];
  selected: string | null;
  layer: Layer;
  onPick: (b: PickedBuilding) => void;
  onMove: (s: Spot) => void;
}) {
  const [box, { w, h }] = useSize<HTMLDivElement>();
  const [broken, setBroken] = useState(false);
  // Zoom so the search circle spans the taller side; imagery stops at 19.
  const z = Math.max(15, Math.min(19, Math.floor(Math.log2((156543.03392 * Math.cos((center.lat * Math.PI) / 180) * Math.max(w, h) * 1.05) / (radiusM * 2)))));
  const c = worldPx(center.lat, center.lng, z);
  const left = c.x - w / 2;
  const top = c.y - h / 2;
  const at = (lat: number, lng: number) => {
    const p = worldPx(lat, lng, z);
    return { x: p.x - left, y: p.y - top };
  };
  const mpp = metresPerPx(center.lat, z);
  const tiles = useMemo(() => {
    const out: { key: string; x: number; y: number; src: string }[] = [];
    const n = 2 ** z;
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++) {
      for (let ty = Math.floor(top / 256); ty <= Math.floor((top + h) / 256); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        out.push({ key: `${z}/${tx}/${ty}`, x: tx * 256 - left, y: ty * 256 - top, src: TILES[layer].url.replace('{z}', String(z)).replace('{x}', String(wx)).replace('{y}', String(ty)) });
      }
    }
    return out;
  }, [z, left, top, w, h, layer]);

  // Nearest buildings keep their label; ones that would overlap become small dots (still tappable,
  // and in the list below). The selected one always shows its label.
  const placed = useMemo(() => {
    const out: { b: PickedBuilding; p: { x: number; y: number }; label: boolean }[] = [];
    const boxes: { x: number; y: number }[] = [];
    const order = [...buildings].sort((a, b) => (a.postcode === selected ? -1 : b.postcode === selected ? 1 : a.distanceM - b.distanceM));
    for (const b of order) {
      const p = at(b.lat, b.lng);
      if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
      const label = !boxes.some((q) => Math.abs(q.x - p.x) < 50 && Math.abs(q.y - p.y) < 30);
      if (label) boxes.push(p);
      out.push({ b, p, label });
    }
    return out.reverse(); // labels paint above dots
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildings, selected, z, left, top, w, h]);
  const centre = at(center.lat, center.lng);
  const me = you ? at(you.lat, you.lng) : null;
  return (
    <div
      ref={box}
      className="tilemap"
      data-broken={broken}
      onClick={(e) => {
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('tile')) return;
        const r = e.currentTarget.getBoundingClientRect();
        const p = fromWorld(left + (e.clientX - r.left), top + (e.clientY - r.top), z);
        haptic(8);
        onMove(p);
      }}
    >
      {tiles.map((t) => (
        <img key={t.key} className="tile" src={t.src} alt="" draggable={false} style={{ left: t.x, top: t.y }} onError={() => setBroken(true)} />
      ))}
      <span className="search-ring" style={{ left: centre.x, top: centre.y, width: (radiusM * 2) / mpp, height: (radiusM * 2) / mpp }} aria-hidden />
      {me && you?.accuracy && <span className="accuracy-ring" style={{ left: me.x, top: me.y, width: (you.accuracy * 2) / mpp, height: (you.accuracy * 2) / mpp }} aria-hidden />}
      {me && <span className="you-dot" style={{ left: me.x, top: me.y }} aria-hidden />}
      {(!you || Math.abs(you.lat - center.lat) > 1e-7 || Math.abs(you.lng - center.lng) > 1e-7) && <span className="spot-pin" style={{ left: centre.x, top: centre.y }} aria-hidden />}
      {placed.map(({ b, p, label }) => {
        return (
          <button
            key={b.postcode}
            type="button"
            className={label ? 'bld' : 'bld dot'}
            aria-pressed={selected === b.postcode}
            aria-label={`${b.address}, postcode ${formatPostcode(b.postcode)}, ${b.distanceM} metres away`}
            style={{ left: p.x, top: p.y }}
            onClick={() => onPick(b)}
          >
            {label ? b.label : ''}
          </button>
        );
      })}
      <span className="tile-credit">{broken ? 'Map images could not load. Buildings still work.' : TILES[layer].credit}</span>
    </div>
  );
}

/** Full-screen picker. Resolves with a building, or a bare spot when the building has no postcode yet. */
export function BuildingPicker({
  onClose,
  onPick,
  onSpot,
  start,
  title = 'Pick your building',
  cta = 'Use',
}: {
  onClose: () => void;
  onPick: (b: PickedBuilding) => void;
  /** Omit where a postcode is required (a home must be a building). */
  onSpot?: (s: Spot) => void;
  start?: Spot | null;
  title?: string;
  cta?: string;
}) {
  const [you, setYou] = useState<Spot | null>(start ?? null);
  const [center, setCenter] = useState<Spot | null>(start ?? null);
  const [radius, setRadius] = useState(100);
  const [list, setList] = useState<PickedBuilding[] | null>(null);
  const [selected, setSelected] = useState<PickedBuilding | null>(null);
  const [layer, setLayer] = useState<Layer>('satellite');
  const [state, setState] = useState<'locating' | 'ready' | 'denied' | 'error'>(start ? 'ready' : 'locating');
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const find = useCallback(async () => {
    setState('locating');
    setMsg(null);
    const p = await locate(10000, 0);
    if (!p) return setState('denied');
    setYou(p);
    setCenter(p);
    setSelected(null);
    setState('ready');
  }, []);

  useEffect(() => {
    if (!start) void find();
  }, [find, start]);

  // Buildings around the search centre; refetched as the radius or centre changes.
  useEffect(() => {
    if (!center) return;
    let alive = true;
    const t = setTimeout(() => {
      api<{ buildings: PickedBuilding[] }>(`/places/within?lat=${center.lat}&lng=${center.lng}&radius=${radius}`)
        .then((r) => {
          if (!alive) return;
          setList(r.buildings);
          setSelected((s) => (s && r.buildings.some((b) => b.postcode === s.postcode) ? s : (r.buildings[0] ?? null)));
        })
        .catch((e) => alive && (setList([]), setMsg(e instanceof ApiError ? e.message : 'Could not load buildings.')));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [center, radius]);

  // Modal behaviour: focus inside, Escape closes, page behind does not scroll.
  useEffect(() => {
    panel.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const nearest = list?.[0];
  // Rendered on <body>: the page wrapper animates with a transform, which would trap a fixed sheet.
  return createPortal(
    <div className="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" ref={panel} tabIndex={-1}>
      <header className="picker-head">
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="back" />
        </button>
        <h2 id="picker-title">{title}</h2>
        <div className="segmented small" role="radiogroup" aria-label="Map style">
          {(
            [
              ['satellite', 'Satellite'],
              ['map', 'Map'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={layer === k} aria-pressed={layer === k} onClick={() => setLayer(k)}>
              {l}
            </button>
          ))}
        </div>
      </header>

      {state === 'denied' ? (
        <div className="card empty" style={{ margin: 16 }}>
          <strong>We could not get your location.</strong>
          Turn on location for this app, then try again.
          <button className="btn block signal" type="button" style={{ marginTop: 12 }} onClick={find}>
            Try again
          </button>
        </div>
      ) : !center ? (
        <div className="tilemap locating" aria-live="polite">
          <span className="you-dot pulse" style={{ left: '50%', top: '50%' }} aria-hidden />
          <span className="tile-credit">Finding where you are…</span>
        </div>
      ) : (
        <TileMap
          center={center}
          you={you}
          radiusM={radius}
          buildings={list ?? []}
          selected={selected?.postcode ?? null}
          layer={layer}
          onPick={(b) => {
            haptic(10);
            setSelected(b);
          }}
          onMove={(p) => {
            setCenter({ ...p });
            setSelected(null);
          }}
        />
      )}

      <div className="picker-body">
        <p className="muted" style={{ margin: 0 }}>
          {state === 'locating' ? 'Finding where you are…' : you?.accuracy ? `Current location accuracy: ${you.accuracy} metres` : 'Location set on the map'}
        </p>
        <p style={{ margin: '4px 0 12px' }}>
          {list == null
            ? 'Looking for buildings…'
            : nearest
              ? `The nearest postcode is ${nearest.distanceM} m away. Tap your building on the map.`
              : 'No building with a postcode here. Widen the search, or tap where you are on the map.'}
        </p>

        <label className="field" style={{ marginBottom: 12 }}>
          <span>
            Search radius <strong>{radius} m</strong>
          </span>
          <input type="range" min={MIN_R} max={MAX_R} step={25} value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-valuetext={`${radius} metres`} />
        </label>

        {selected && (
          <div className="postcode-card" aria-live="polite">
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="postcode">{formatPostcode(selected.postcode)}</span>
              <span className="muted" style={{ display: 'block' }}>
                {selected.address}, {selected.area} · {selected.distanceM} m
              </span>
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label={copied ? 'Copied' : 'Copy postcode'}
              onClick={() => {
                void navigator.clipboard?.writeText(selected.postcode);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} size={18} />
            </button>
          </div>
        )}
        {msg && <span className="field-error">{msg}</span>}

        <button className="btn block primary" type="button" disabled={!selected} onClick={() => selected && onPick(selected)}>
          {selected ? `${cta} ${formatPostcode(selected.postcode)}` : 'Tap a building'}
        </button>
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn" type="button" onClick={find} disabled={state === 'locating'}>
            {state === 'locating' ? 'Locating…' : 'Retry location'}
          </button>
          {onSpot && (
            <button className="btn" type="button" disabled={!center} onClick={() => center && onSpot(center)}>
              Use this spot
            </button>
          )}
        </div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)' }}>
          {onSpot
            ? 'Did not find your building? “Use this spot” sends the place on the map without a postcode.'
            : 'Did not find your building? Widen the search, or tap closer to it on the map.'}
        </p>

        {list && list.length > 1 && (
          <details className="bld-list">
            <summary>Choose from a list ({list.length})</summary>
            <ul className="list">
              {list.slice(0, 12).map((b) => (
                <li key={b.postcode}>
                  <button type="button" className="row" aria-pressed={selected?.postcode === b.postcode} onClick={() => setSelected(b)}>
                    <span className="grow">
                      <strong className="postcode small">{formatPostcode(b.postcode)}</strong>
                      <span className="sub">
                        {b.address} · {b.distanceM} m
                      </span>
                    </span>
                    {selected?.postcode === b.postcode && <Icon name="check" size={18} />}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>,
    document.body,
  );
}
