'use client';

import { freshness, type Freshness } from '@erp/domain';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { streamUrl } from '@erp/web-ui/api';
import { StateChip } from '@erp/web-ui/StateChip';
import { FalseAlarmReview, ReinforceSheet, StatementCard } from '@/components/IncidentExtras';
import { api, ApiError } from '@erp/web-ui/api';
import { StationActions } from '@/components/StationActions';

interface Extras {
  units: { name: string; badgeNo: string | null; role: string; state: string; acceptedAt: string | null; offeredAt: string; secondsLeft: number | null; distanceM: number | null; declineReason: string | null }[];
  reports: { role: string; source: string; type: string; detail: string | null; at: string; who: string; trustBand: string }[];
  notes: { text: string; at: string; by: string | null }[];
}
const UNIT: Record<string, [string, string]> = {
  offered: ['Offered', 'warning'],
  accepted: ['Accepted', 'info'],
  en_route: ['En route', 'info'],
  on_scene: ['On scene', 'success'],
  declined: ['Declined', 'neutral'],
  expired: ['Missed', 'neutral'],
  dropped: ['Handed over', 'neutral'],
  released: ['Released', 'neutral'],
  taken: ['Taken', 'neutral'],
};

interface StationView {
  id: string;
  type: string;
  state: string;
  reportCount: number;
  brief?: { summary: string; confidence: string };
  reporter: { name: string; trustBand: string };
  building: { postcode: string; address: string; areaLabel: string };
  officer?: { name: string; badgeNo: string; stationName: string };
  etaMinutes?: number;
  timeline: Array<{ at: string; kind: string; label: string; public: boolean; by?: string }>;
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
  const [x, setX] = useState<Extras | null>(null);
  const [reinforcing, setReinforcing] = useState(false);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const version = v ? `${v.state}-${v.timeline.length}` : '';
  useEffect(() => {
    api<Extras>(`/incidents/${id}/station-detail`).then(setX).catch(() => {});
  }, [id, version]);

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

      <FalseAlarmReview incidentId={v.id} onDone={setToast} />
      <div className="grid two">
        <section className="card" aria-labelledby="who">
          <h2 id="who">Reporter and place</h2>
          <dl className="facts">
            <div>
              <dt>Reporter</dt>
              <dd>
                {v.reporter.name}. Trust {v.reporter.trustBand}. Contact through the app only.
              </dd>
            </div>
            <div>
              <dt>Building</dt>
              <dd>
                {v.building.postcode ? `Postcode ${v.building.postcode}, ` : ''}
                {v.building.address}, {v.building.areaLabel}
              </dd>
            </div>
            {x?.reports[0]?.detail && (
              <div>
                <dt>What they chose</dt>
                <dd style={{ textTransform: 'none' }}>
                  {v.type}, then “{x.reports[0].detail}”
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section className="card" aria-labelledby="brief">
          <h2 id="brief">Brief (advisory)</h2>
          <div className="banner info" style={{ margin: 0 }}>
            {v.brief ? (
              <>
                {v.brief.summary}
                <strong style={{ display: 'block' }}>Confidence: {v.brief.confidence}.</strong>
              </>
            ) : (
              'No brief yet. It is built from nearby device clips and the reporter’s answers when available.'
            )}
          </div>
          <p className="muted">The brief helps you decide. It never sends anyone by itself, and officers confirm what they find on scene.</p>
        </section>
      </div>

      <section className="card" aria-labelledby="units">
        <h2 id="units">Units on this report</h2>
        {!x && <div className="skeleton" />}
        {x?.units.length === 0 && <p className="muted">No unit has been offered this report yet.</p>}
        {x?.units.map((u, i) => (
          <div className="row" key={i}>
            <div className="label">
              <strong>
                {u.badgeNo ? `${u.badgeNo}, ` : ''}
                {u.name}
                {u.role === 'reinforcement' ? ' (second unit)' : ''}
              </strong>
              <span>
                {u.state === 'offered'
                  ? `Offered, ${u.secondsLeft ?? 0}s left`
                  : u.acceptedAt
                    ? `Accepted ${new Date(u.acceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${u.distanceM != null && ['accepted', 'en_route'].includes(u.state) ? `, ${(u.distanceM / 1000).toFixed(1)} km away` : ''}`
                    : u.declineReason
                      ? `Declined: ${u.declineReason.replace('_', ' ')}`
                      : `Offered ${new Date(u.offeredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
              </span>
            </div>
            <span className={`chip ${UNIT[u.state]?.[1] ?? 'neutral'}`}>{UNIT[u.state]?.[0] ?? u.state}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['accepted', 'en_route', 'on_scene'].includes(v.state) && (
            <button className="btn signal" type="button" onClick={() => setReinforcing(true)}>
              Reinforce
            </button>
          )}
        </div>
        <StationActions incidentId={v.id} state={v.state} actions={v.actions} onDone={setToast} />
      </section>

      <div className="grid two">
        <section className="card" aria-labelledby="reports">
          <h2 id="reports">Reports on this incident ({x?.reports.length ?? v.reportCount})</h2>
          {(x?.reports.length ?? 0) > 1 && <div className="banner success">Merged automatically: same building, same type. Only one dispatch was made.</div>}
          {x?.reports.map((r, i) => (
            <div className="row" key={i}>
              <div className="label">
                <strong>
                  {r.who}, {r.type}
                  {r.detail ? `, “${r.detail}”` : ''}
                </strong>
                <span>
                  {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {r.source === 'device' ? 'Device' : 'App report'}, trust {r.trustBand}
                </span>
              </div>
              <span className={`chip ${r.role === 'first' ? 'info' : r.role === 'device' ? 'neutral' : 'success'}`}>{r.role === 'first' ? 'First report' : r.role === 'device' ? 'Device' : 'Joined'}</span>
            </div>
          ))}
          <p className="muted" style={{ marginBottom: 0 }}>
            Everyone who reported sees the same status. People who join a confirmed incident are never fined for a false alarm.
          </p>
        </section>
        <StatementCard incidentId={v.id} state={v.state} onDone={setToast} />
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="tl">
          <h2 id="tl">Timeline</h2>
          <ol className="timeline">
            {v.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <span>
                  {e.label}
                  {e.by && e.by !== 'System' && <span className="muted"> · {e.by}</span>}
                  {!e.public && <span className="chip neutral" style={{ marginLeft: 8 }}>internal</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="card" aria-labelledby="notes">
          <h2 id="notes">Notes and closing</h2>
          <label className="field" data-invalid={!!noteErr}>
            <span>Add a note for the log</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-invalid={!!noteErr} />
            {noteErr && <span className="field-error">{noteErr}</span>}
          </label>
          <button
            className="btn"
            type="button"
            onClick={async () => {
              if (!note.trim()) return setNoteErr('Write a note before saving.');
              setNoteErr(null);
              try {
                await api(`/incidents/${v.id}/events`, { method: 'POST', body: JSON.stringify({ kind: 'note', text: note.trim() }) });
                setNote('');
                setToast('Note saved.');
              } catch (e) {
                setNoteErr(e instanceof ApiError ? e.message : 'Could not save.');
              }
            }}
          >
            Save note
          </button>
          {x?.notes.map((n, i) => (
            <div className="row" key={i}>
              <div className="label">
                <strong>{n.text}</strong>
                <span>
                  {n.by ?? 'Someone'} · {new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          ))}
          <p className="muted" style={{ marginBottom: 0 }}>
            Close the report from the unit actions above. A false alarm is marked by the officer and confirmed by you before any fine, which the citizen can appeal.
          </p>
        </section>
      </div>
      {reinforcing && (
        <ReinforceSheet
          incidentId={v.id}
          onClose={() => setReinforcing(false)}
          onDone={(m) => {
            setReinforcing(false);
            setToast(m);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
}
