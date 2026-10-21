'use client';
// "Filter by location" (boards: Admin overview, Users, Subscriptions, live maps). Five cascading
// lists, each loaded from the NIPOST postcode service for the level above it, and a postcode search.
import { api } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';

export interface LocFilter {
  state?: string;
  lga?: string;
  district?: string;
  area?: string;
  building?: string;
  postcode?: string;
}
type Level = 'state' | 'lga' | 'district' | 'area' | 'building';
const LEVELS: [Level, string, string][] = [
  ['state', 'State', 'All states'],
  ['lga', 'LGA', 'All LGAs'],
  ['district', 'District', 'All districts'],
  ['area', 'Area', 'All areas'],
  ['building', 'Building', 'All buildings'],
];

/** Query string for the API: only the levels chosen. */
export const locQuery = (f: LocFilter) =>
  Object.entries(f)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export function LocationFilter({ value, onChange, title = 'Filter by location' }: { value: LocFilter; onChange: (f: LocFilter) => void; title?: string }) {
  const [opts, setOpts] = useState<Partial<Record<Level, { id: string; name: string }[]>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [pc, setPc] = useState(value.postcode ?? '');

  // Load each level once the one above it is chosen.
  useEffect(() => {
    const load = (level: Level, parent?: string) =>
      api<{ id: string; name: string }[]>(`/places/levels/${level}${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`)
        .then((xs) => setOpts((o) => ({ ...o, [level]: xs })))
        .catch((e) => setErr(e?.message ?? 'Postcode lookup is not available.'));
    void load('state');
    if (value.state) void load('lga', value.state);
    if (value.lga) void load('district', value.lga);
    if (value.district) void load('area', value.district);
    if (value.area) void load('building', value.area);
  }, [value.state, value.lga, value.district, value.area]);

  useEffect(() => {
    const t = setTimeout(() => pc !== (value.postcode ?? '') && onChange({ ...value, postcode: pc || undefined }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc]);

  const pick = (level: Level, id: string) => {
    const i = LEVELS.findIndex(([l]) => l === level);
    const next: LocFilter = { postcode: value.postcode };
    LEVELS.slice(0, i).forEach(([l]) => (next[l] = value[l]));
    if (id) next[level] = id;
    onChange(next);
  };
  const any = LEVELS.some(([l]) => value[l]) || !!value.postcode;
  return (
    <section className="card loc-filter" aria-labelledby="loc">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 id="loc" style={{ margin: 0, fontSize: 'var(--text-md, 1rem)' }}>
          {title}
        </h2>
        <input className="search" type="search" placeholder="Search a postcode" value={pc} onChange={(e) => setPc(e.target.value.toUpperCase())} aria-label="Search a postcode" style={{ minWidth: 220 }} />
      </div>
      <div className="loc-grid">
        {LEVELS.map(([level, label, all], i) => {
          const parentChosen = i === 0 || !!value[LEVELS[i - 1]![0]];
          return (
            <label key={level} className="field" style={{ margin: 0 }}>
              <span>{label}</span>
              <select value={value[level] ?? ''} disabled={!parentChosen} onChange={(e) => pick(level, e.target.value)} data-on={!!value[level]}>
                <option value="">{all}</option>
                {(parentChosen ? (opts[level] ?? []) : []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
        <button className="btn" type="button" disabled={!any} onClick={() => (setPc(''), onChange({}))} style={{ alignSelf: 'end' }}>
          Clear
        </button>
      </div>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        {err ?? 'Each list is loaded from the Nigeria postcode service for the level above it.'}
      </p>
    </section>
  );
}
