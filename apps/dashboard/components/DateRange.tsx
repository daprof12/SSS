'use client';
// "Date range" for the data pages: quick choices (7 days, 30 days, this month, this year, all) or
// two dates. Days are calendar days in Lagos; both ends are included.
import { useState } from 'react';

export interface Range {
  from?: string;
  to?: string;
}
type Preset = '7d' | '30d' | 'month' | 'year' | 'all' | 'custom';

const lagosToday = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export function presetRange(p: Exclude<Preset, 'custom'>): Range {
  const to = lagosToday();
  if (p === '7d') return { from: minusDays(to, 6), to };
  if (p === '30d') return { from: minusDays(to, 29), to };
  if (p === 'month') return { from: `${to.slice(0, 7)}-01`, to };
  if (p === 'year') return { from: `${to.slice(0, 4)}-01-01`, to };
  return {};
}

/** Query string for the API: only the ends chosen. */
export const dateQuery = (r: Range) => [r.from && `from=${r.from}`, r.to && `to=${r.to}`].filter(Boolean).join('&');

const PRESETS: [Preset, string][] = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
  ['custom', 'Dates'],
];

export function DateRange({ value, onChange, initial = '30d', allowAll = true }: { value: Range; onChange: (r: Range) => void; initial?: Preset; allowAll?: boolean }) {
  const [preset, setPreset] = useState<Preset>(initial);
  const bad = !!value.from && !!value.to && value.from > value.to;
  return (
    <div className="date-range" role="group" aria-label="Date range">
      <div className="segmented" role="radiogroup" aria-label="Period">
        {PRESETS.filter(([p]) => allowAll || p !== 'all').map(([p, label]) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={preset === p}
            aria-pressed={preset === p}
            onClick={() => {
              setPreset(p);
              if (p !== 'custom') onChange(presetRange(p));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="date-range-fields">
          <label className="field">
            <span>From</span>
            <input type="date" value={value.from ?? ''} max={value.to || lagosToday()} onChange={(e) => onChange({ ...value, from: e.target.value || undefined })} aria-invalid={bad} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={value.to ?? ''} min={value.from} max={lagosToday()} onChange={(e) => onChange({ ...value, to: e.target.value || undefined })} aria-invalid={bad} />
          </label>
          {bad && <span className="field-error">The start date must be on or before the end date.</span>}
        </div>
      )}
    </div>
  );
}

/** Keeps the chosen range; starts on the given preset. */
export function useDateRange(initial: Exclude<Preset, 'custom'> = '30d') {
  const [range, setRange] = useState<Range>(() => presetRange(initial));
  const ok = !(range.from && range.to && range.from > range.to);
  return { range, setRange, initial, ok, q: ok ? dateQuery(range) : null };
}
