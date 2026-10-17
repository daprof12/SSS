'use client';

import { freshness, type Freshness } from '@erp/domain';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { streamUrl } from '@erp/web-ui/api';
import { StateChip } from '@erp/web-ui/StateChip';
import { StationActions } from '@/components/StationActions';

interface StationView {
  id: string;
  type: string;
  state: string;
  reportCount: number;
  reporter: { name: string; trustBand: string };
  building: { postcode: string; address: string; areaLabel: string };
  officer?: { name: string; badgeNo: string; stationName: string };
  etaMinutes?: number;
  timeline: Array<{ at: string; kind: string; label: string; public: boolean }>;
  notes: Array<{ text: string; at: string }>;
  actions: string[];
  serverTime: string;
}

/** One incident, live over SSE, with the freshness line from §A3. */
export default function IncidentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<StationView | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState<Date | null>(null);
  const [now, setNow] = useState(new Date());
  const [ended, setEnded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const es = new EventSource(streamUrl(`/incidents/${id}/stream`));
    es.addEventListener('incident', (e) => {
      setV(JSON.parse((e as MessageEvent).data));
      setLastAt(new Date());
      setConnected(true);
    });
    es.addEventListener('heartbeat', () => setLastAt(new Date()));
    es.addEventListener('gone', (e) => {
      es.close();
      setConnected(false);
      setEnded(JSON.parse((e as MessageEvent).data).message);
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      if (es.readyState === EventSource.CLOSED) setEnded('This report is no longer available to you.');
    };
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      es.close();
      clearInterval(tick);
    };
  }, [id]);

  const f: Freshness | null = lastAt ? freshness(lastAt, now, connected) : null;

  if (ended) {
    return (
      <div className="card empty">
        <strong>{ended}</strong>
        <Link href="/incidents">Back to live incidents</Link>
      </div>
    );
  }
  if (!v) {
    return (
      <>
        <div className="skeleton" style={{ height: 40, width: 320 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </>
    );
  }

  return (
    <>
      <p style={{ margin: '0 0 8px' }}>
        <Link href="/incidents">← Live incidents</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ textTransform: 'capitalize' }}>
          {v.type}, {v.building.postcode || 'GPS location'}
        </h1>
        <StateChip state={v.state} />
        {v.reportCount > 1 && <span className="chip info">{v.reportCount} reports</span>}
        <span className="spacer" />
        {f && (
          <span className={`live ${f.kind === 'live' ? '' : f.kind === 'stale' ? 'stale' : 'off'}`} role="status" aria-live="polite">
            <i aria-hidden />
            {f.kind === 'live' ? 'Live' : f.kind === 'stale' ? `Updated ${f.secondsAgo}s ago` : 'Reconnecting…'}
          </span>
        )}
      </div>
      <p className="lede">
        {v.building.address}, {v.building.areaLabel}
      </p>

      {v.state === 'escalated' && (
        <div className="banner critical" role="alert">
          <strong>No one has accepted this report.</strong>
          Assign a unit now or transfer it.
        </div>
      )}

      <div className="grid two">
        <section className="card" aria-labelledby="who">
          <h2 id="who">Reporter and responder</h2>
          <div className="row">
            <div className="label">
              <strong>Reporter</strong>
              <span>{v.reporter.name}. Contact through the app only.</span>
            </div>
            <span className={`chip ${v.reporter.trustBand === 'high' ? 'success' : v.reporter.trustBand === 'low' ? 'warning' : 'neutral'}`}>Trust {v.reporter.trustBand}</span>
          </div>
          <div className="row">
            <div className="label">
              <strong>Officer</strong>
              <span>{v.officer ? `${v.officer.name}, badge ${v.officer.badgeNo}` : 'Not accepted yet'}</span>
            </div>
            {v.etaMinutes != null && <span className="chip info">ETA {v.etaMinutes} min</span>}
          </div>
          <StationActions incidentId={v.id} state={v.state} actions={v.actions} onDone={setToast} />
        </section>

        <section className="card" aria-labelledby="tl">
          <h2 id="tl">Timeline</h2>
          <ol className="timeline">
            {v.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <span>
                  {e.label}
                  {!e.public && <span className="chip neutral" style={{ marginLeft: 8 }}>internal</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
}
