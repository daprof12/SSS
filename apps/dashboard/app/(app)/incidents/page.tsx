'use client';
// Board "Station dashboard": stats, the priority queue, the live map of the zone, and the selected
// report with its brief, timeline, Reinforce and Transfer. Polls every 3 s (the station socket replaces it).
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/Agency';
import { ago, STATE_LABEL, stateTone, ZoneMap, type MapIncident, type MapUnit } from '@/components/Dash';
import { ReinforceSheet } from '@/components/IncidentExtras';
import { StationActions } from '@/components/StationActions';

interface QueueRow {
  id: string;
  type: string;
  state: string;
  reportCount: number;
  postcode: string | null;
  area: string | null;
  officer: string | null;
  offerExpiresAt: string | null;
  trustBand: string;
  severity: number;
  createdAt: string;
}
interface Summary {
  station: { name: string; agency: string };
  stats: { open: number; critical: number; medianAcceptS: number | null; acceptsToday: number; onDuty: number; available: number; officers: number; ratingToday: number | null; ratingMonth: number | null; falseAlarmReviews: number };
}
interface MapData {
  center: { lat: number; lng: number };
  zoneRadiusM: number;
  stationPlaced: boolean;
  incidents: MapIncident[];
  units: MapUnit[];
}
interface View {
  id: string;
  type: string;
  state: string;
  brief?: { summary: string; confidence: string };
  timeline: { at: string; label: string; by?: string }[];
  actions: string[];
  canDirectAssign?: boolean;
}
const tone: Record<string, string> = { critical: 'var(--color-emergency)', warning: 'var(--color-warning)', success: 'var(--color-success)', info: 'var(--color-signal)' };

export default function Incidents() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [map, setMap] = useState<MapData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useToast();
  const tickRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const [q, s] = await Promise.all([api<QueueRow[]>('/me/queue'), api<Summary>('/me/station/summary')]);
      setRows(q);
      setSum(s);
      setError(null);
      // The map moves less: every third poll.
      if (tickRef.current++ % 3 === 0) setMap(await api<MapData>('/me/station/map'));
      setSel((cur) => (cur && q.some((r) => r.id === cur) ? cur : (q[0]?.id ?? null)));
    } catch (e) {
      setError(e as ApiError);
    }
  }, []);
  useEffect(() => {
    void load();
    const poll = setInterval(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const st = sum?.stats;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Live incidents</h1>
          <p className="lede">Incident queue, map and detail for {sum?.station.name ?? 'this station'}.</p>
        </div>
      </div>
      {error && (
        <div className={`banner ${error.status === 0 ? 'warning' : 'critical'}`} role="alert">
          <strong>{error.status === 0 ? 'You are offline.' : 'Could not load the queue'}</strong>
          {error.status === 0 ? 'Showing the last list we had.' : error.message}
        </div>
      )}
      {!!st?.falseAlarmReviews && (
        <Link className="banner warning" href="/station/reports" style={{ display: 'block', textDecoration: 'none' }}>
          <strong>
            {st.falseAlarmReviews} false {st.falseAlarmReviews === 1 ? 'alarm waits' : 'alarms wait'} for you to confirm
          </strong>
          Nothing reaches the reporter until you decide, or 48 hours pass.
        </Link>
      )}
      <div className="stats">
        <div className="stat">
          <span>Open incidents</span>
          <strong className="critical">{st?.open ?? '—'}</strong>
          <small>{st ? `${st.critical} critical` : ''}</small>
        </div>
        <div className="stat">
          <span>Median time to accept</span>
          <strong className="info">{st?.medianAcceptS != null ? `${st.medianAcceptS} s` : '—'}</strong>
          <small>{st ? (st.acceptsToday ? `${st.acceptsToday} accepted in 24 h` : 'No offers in 24 h') : ''}</small>
        </div>
        <div className="stat">
          <span>Officers on duty</span>
          <strong>{st?.onDuty ?? '—'}</strong>
          <small>{st ? `${st.available} available` : ''}</small>
        </div>
        <div className="stat">
          <span>Average rating today</span>
          <strong className="success">{st?.ratingToday ?? st?.ratingMonth ?? '—'}</strong>
          <small>{st?.ratingToday != null ? 'From reporters' : st?.ratingMonth != null ? 'Last 30 days' : 'No ratings yet'}</small>
        </div>
      </div>

      <div className="dash-three">
        <section className="card" aria-labelledby="queue">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <h2 id="queue" style={{ margin: 0 }}>
              Queue
            </h2>
            <span className="muted">Sorted by priority</span>
          </div>
          <div style={{ marginTop: 12 }}>
            {rows === null && !error && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
            {rows?.length === 0 && (
              <div className="empty">
                <strong>No open reports.</strong>
                New reports for your area appear here as they come in.
              </div>
            )}
            {rows?.map((r) => {
              const left = r.offerExpiresAt ? Math.max(0, Math.round((+new Date(r.offerExpiresAt) - now) / 1000)) : null;
              const t = stateTone(r.state);
              return (
                <button key={r.id} type="button" className="q-card" aria-pressed={sel === r.id} onClick={() => setSel(r.id)} style={{ ['--q' as string]: tone[t] }}>
                  <span className="q-top">
                    <strong style={{ textTransform: 'capitalize' }}>{r.type}</strong>
                    <strong style={{ color: tone[t] }}>{STATE_LABEL[r.state] ?? r.state}</strong>
                  </span>
                  <span className="q-sub">
                    <span>
                      {r.postcode ?? 'GPS only'}
                      {r.area ? `, ${r.area}` : ''}
                    </span>
                    <span>{r.state === 'offered' && left != null ? `${left}s to accept` : ago(r.createdAt, now)}</span>
                  </span>
                  <span className="q-reports">
                    {r.reportCount} {r.reportCount === 1 ? 'report' : 'reports'}
                    {r.officer ? <span className="muted" style={{ fontWeight: 400 }}> · {r.officer}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="card" aria-label="Live map, station zone" style={{ padding: 12 }}>
          {map ? (
            <>
              <ZoneMap center={map.center} radiusM={map.stationPlaced ? map.zoneRadiusM : 1e9} showStation={map.stationPlaced} incidents={map.incidents} units={map.units} selected={sel} onSelect={setSel} height={460} />
              <div className="map-legend">
                <span>● Incident</span>
                <span>◆ Unit</span>
                <span>■ Station</span>
                <Link href="/station/map">Open full map</Link>
              </div>
            </>
          ) : (
            <div className="skeleton" style={{ height: 460 }} />
          )}
        </section>

        <Selected id={sel} onToast={setToast} onChanged={load} />
      </div>
    </>
  );
}

function Selected({ id, onToast, onChanged }: { id: string | null; onToast: (m: string) => void; onChanged: () => void }) {
  const [v, setV] = useState<View | null>(null);
  const [reinforcing, setReinforcing] = useState(false);
  useEffect(() => {
    setV(null);
    if (!id) return;
    let stop = false;
    const get = () => api<View>(`/incidents/${id}`).then((x) => !stop && setV(x)).catch(() => {});
    void get();
    const t = setInterval(get, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id]);
  if (!id) return <section className="card empty">Choose a report in the queue.</section>;
  if (!v) return <section className="card"><div className="skeleton" style={{ height: 300 }} /></section>;
  const t = stateTone(v.state);
  return (
    <section className="card" aria-labelledby="sel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h2 id="sel" style={{ margin: 0, textTransform: 'capitalize' }}>
          <Link href={`/incidents/${v.id}`}>{v.type}</Link>
        </h2>
        <span className={`chip ${t}`}>{STATE_LABEL[v.state] ?? v.state}</span>
      </div>
      <div className="card" style={{ margin: '12px 0', background: 'var(--color-bg)' }}>
        <strong>Brief</strong>
        <p style={{ margin: '6px 0' }}>{v.brief ? v.brief.summary : 'No brief yet. The plain report is enough to act on.'}</p>
        {v.brief && <span style={{ color: 'var(--color-signal-text)', fontWeight: 600 }}>Confidence: {v.brief.confidence}.</span>}
      </div>
      <strong>Timeline</strong>
      <ol className="timeline">
        {v.timeline.slice(-8).map((e, i) => (
          <li key={i}>
            <time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <span>
              {e.label}
              {e.by && e.by !== 'System' ? <span className="muted"> · {e.by}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {['accepted', 'en_route', 'on_scene'].includes(v.state) && (
          <button className="btn signal" type="button" onClick={() => setReinforcing(true)}>
            Reinforce
          </button>
        )}
        <Link className="btn" href={`/incidents/${v.id}`}>
          Open
        </Link>
      </div>
      <StationActions incidentId={v.id} state={v.state} actions={v.actions} canDirectAssign={!!v.canDirectAssign} onDone={(m) => (onToast(m), onChanged())} />
      {reinforcing && (
        <ReinforceSheet
          incidentId={v.id}
          onClose={() => setReinforcing(false)}
          onDone={(m) => {
            setReinforcing(false);
            onToast(m);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
