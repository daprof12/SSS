'use client';
// Live map of reports (boards "Admin live incident map" and each agency's map): emergencies and
// incidents, report tips, and public issues, each with its own colour, filtered by kind and place.
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ago, STATE_LABEL, ZoneMap, type MapUnit } from './Dash';
import { LocationFilter, locQuery, type LocFilter } from './LocationFilter';

type Kind = 'emergency' | 'tip' | 'issue';
interface Item {
  id: string;
  kind: Kind;
  label: string;
  state: string;
  lat: number;
  lng: number;
  at: string;
  line: string;
  reports: number;
  href: string;
}
interface Live {
  counts: Record<Kind, number>;
  items: Item[];
  units: (MapUnit & { station: string })[];
}
export const KIND: Record<Kind, { label: string; color: string }> = {
  emergency: { label: 'Emergencies and incidents', color: 'var(--color-emergency)' },
  tip: { label: 'Report tips', color: '#a78bfa' },
  issue: { label: 'Public issues', color: 'var(--color-warning)' },
};
const ISSUE_STATE: Record<string, string> = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress', awaiting_check: 'Awaiting check', reopened: 'Reopened' };
const TIP_STATE: Record<string, string> = { sent: 'New', in_queue: 'In queue', more_info: 'More info asked', claim_review: 'Claim review' };

export function LiveReports({ path, kinds }: { path: string; kinds: Kind[] }) {
  const [on, setOn] = useState<Kind[]>(kinds);
  const [loc, setLoc] = useState<LocFilter>({});
  const [l, setL] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const q = `kinds=${on.join(',')}${locQuery(loc) ? `&${locQuery(loc)}` : ''}`;
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Live>(`${path}?${q}`)
        .then((x) => !stop && (setL(x), setError(null)))
        .catch((e) => !stop && setError(e instanceof ApiError ? e.message : 'Could not load the map.'));
    void load();
    const t = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [path, q]);
  const pts = (l?.items ?? []) as { lat: number; lng: number }[];
  const center = pts.length ? { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length } : { lat: 6.6018, lng: 3.3515 };
  const toggle = (k: Kind) => setOn((xs) => (xs.includes(k) ? (xs.length > 1 ? xs.filter((x) => x !== k) : xs) : [...xs, k]));
  const stateLabel = (i: Item) => (i.kind === 'emergency' ? (STATE_LABEL[i.state] ?? i.state) : i.kind === 'tip' ? (TIP_STATE[i.state] ?? i.state) : (ISSUE_STATE[i.state] ?? i.state));
  return (
    <>
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="chips" role="group" aria-label="Type of report" style={{ marginBottom: 12 }}>
        {kinds.map((k) => (
          <button key={k} type="button" aria-pressed={on.includes(k)} onClick={() => toggle(k)}>
            <span style={{ color: KIND[k].color }}>●</span> {KIND[k].label} {l ? <span className="muted">{l.counts[k]}</span> : null}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <section className="card" style={{ padding: 12 }}>
          {l ? (
            <ZoneMap
              center={center}
              radiusM={1e9}
              incidents={l.items.map((i) => ({ ...i, color: i.kind === 'emergency' ? undefined : KIND[i.kind].color }))}
              units={l.units}
              selected={sel}
              onSelect={setSel}
              showStation={false}
              height={580}
            />
          ) : (
            <div className="skeleton" style={{ height: 580 }} />
          )}
          <div className="map-legend">
            {kinds.map((k) => (
              <span key={k}>
                <span style={{ color: KIND[k].color }}>●</span> {KIND[k].label}
              </span>
            ))}
            <span>◆ Unit on duty (filled: free)</span>
          </div>
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Open now ({l?.items.length ?? 0})</h2>
          {l && !l.items.length && <p className="muted">Nothing open here.</p>}
          {l?.items.map((i) => (
            <div key={`${i.kind}-${i.id}`} className="row" style={{ background: sel === i.id ? 'var(--color-signal-soft)' : undefined, borderRadius: 8, paddingLeft: 6 }} onClick={() => setSel(i.id)}>
              <div className="label">
                <strong>
                  <span style={{ color: KIND[i.kind].color }}>●</span> <Link href={i.href}>{i.label}</Link>
                </strong>
                <span>
                  {i.line} · {ago(i.at)} ago
                </span>
              </div>
              <strong>{stateLabel(i)}</strong>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
