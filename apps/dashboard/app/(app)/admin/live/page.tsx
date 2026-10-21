'use client';
// Board "Admin live incident map": every open report and unit on duty, across all agencies.
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { ago, STATE_LABEL, stateTone, ZoneMap, type MapIncident, type MapUnit } from '@/components/Dash';

interface L {
  incidents: (MapIncident & { reports: number; station: string | null; agency: string | null; officer: string | null; at: string })[];
  units: (MapUnit & { station: string })[];
}
const tone: Record<string, string> = { critical: 'var(--color-emergency-text)', warning: 'var(--color-warning-text)', success: 'var(--color-success-text)', info: 'var(--color-signal-text)' };

export default function LiveMap() {
  const [l, setL] = useState<L | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      api<L>('/admin/live')
        .then(setL)
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the map.'));
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const pts = [...(l?.incidents ?? []), ...(l?.units ?? [])].filter((p) => p.lat != null) as { lat: number; lng: number }[];
  const center = pts.length ? { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length } : { lat: 6.6018, lng: 3.3515 };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live incident map</h1>
          <p className="lede">Every open report and every unit on duty, across all agencies. Refreshes every 5 seconds.</p>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <section className="card" style={{ padding: 12 }}>
          {l ? <ZoneMap center={center} radiusM={1e9} incidents={l.incidents} units={l.units} selected={sel} onSelect={setSel} showStation={false} height={580} /> : <div className="skeleton" style={{ height: 580 }} />}
          <div className="map-legend">
            <span>● Open report (red: no taker)</span>
            <span>◆ Unit on duty (filled: free)</span>
          </div>
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Open reports ({l?.incidents.length ?? 0})</h2>
          {l && !l.incidents.length && <p className="muted">Nothing open right now.</p>}
          {l?.incidents.map((i) => (
            <button key={i.id} type="button" className="row" onClick={() => setSel(i.id)} style={{ width: '100%', background: sel === i.id ? 'var(--color-signal-soft)' : 'none', border: 0, color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
              <div className="label">
                <strong>{i.label}</strong>
                <span>
                  {i.agency ?? 'No agency'}
                  {i.station ? `, ${i.station}` : ''} · {i.officer ?? 'no unit'} · {ago(i.at)} ago
                </span>
              </div>
              <strong style={{ color: tone[stateTone(i.state)] }}>{STATE_LABEL[i.state] ?? i.state}</strong>
            </button>
          ))}
        </section>
      </div>
    </>
  );
}
