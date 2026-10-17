'use client';

import { CloseReportSheet } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { StateChip } from '@erp/web-ui/StateChip';
import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { MiniMap } from '@/components/MiniMap';
import { api, ApiError, haptic, locate, typeInfo } from '@/lib/client';
import { FreshLabel, useIncident } from '@/lib/useIncident';
import { Attachments } from '@/components/reports/Attach';

interface LatLng {
  lat: number;
  lng: number;
}
interface OfficerView {
  id: string;
  type: string;
  state: string;
  reportCount: number;
  reporter: { label: string; trustBand: string };
  building: { postcode: string; address: string; areaLabel: string; location: LatLng };
  brief?: { summary: string; confidence: string };
  team?: { name: string; badgeNo: string };
  timeline: Array<{ at: string; kind: string; label: string }>;
  notes: Array<{ text: string; at: string }>;
  rating?: { stars: number; comment?: string };
  actions: string[];
}

const PING_MS = 10000;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Officer incident detail (board "Officer incident detail") with the next action first. */
export default function OfficerIncident({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { view: v, gone, fresh } = useIncident<OfficerView>(id);
  const [sheet, setSheet] = useState<'note' | 'help' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<LatLng | null>(null);
  const [toast, setToast] = useToast();

  const panicActive = (v?.timeline ?? []).reduce((on, e) => (e.kind === 'officer_panic' ? true : e.kind === 'panic_cleared' ? false : on), false);

  // Location pings while on the way: the citizen's ETA and map follow (Phase 1 API).
  useEffect(() => {
    if (!v || !['accepted', 'en_route'].includes(v.state)) return;
    let stop = false;
    const ping = async () => {
      const p = await locate(5000);
      if (stop || !p) return;
      setMe(p);
      await api('/me/officer/location', { method: 'POST', body: JSON.stringify(p) }).catch(() => {});
    };
    void ping();
    const t = setInterval(ping, PING_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [v?.state, v]);

  const act = async (event: string, label: string) => {
    setBusy(true);
    try {
      await api(`/incidents/${id}/actions`, { method: 'POST', body: JSON.stringify({ event }) });
      haptic(30);
      setToast(label);
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Updates will send when you are back online.');
    } finally {
      setBusy(false);
    }
  };

  if (gone) {
    return (
      <main className="app bare">
        <Header back="/officer" />
        <div className="card empty">
          <strong>{gone}</strong>
          <Link href="/officer">Back to Home</Link>
        </div>
      </main>
    );
  }
  if (!v) {
    return (
      <main className="app bare">
        <div className="skeleton" style={{ height: 220 }} />
        <div className="skeleton" style={{ height: 120 }} />
      </main>
    );
  }

  const info = typeInfo(v.type);
  const live = ['accepted', 'en_route', 'on_scene', 'closing'].includes(v.state);
  const primary =
    v.state === 'accepted' ? { label: "I'm on my way", run: () => act('start_route', 'Marked on the way.') } :
    v.state === 'en_route' ? { label: 'I am on scene', run: () => act('arrive', 'Marked on scene. Location sharing stopped.') } :
    v.state === 'on_scene' || v.state === 'closing' ? { label: 'Close report', run: () => setSheet('close') } : null;

  return (
    <main className="app bare">
      <Header title={`${info.label}, ${v.building.postcode || 'GPS'}`} back="/officer">
        <StateChip state={v.state} />
      </Header>
      {live && <FreshLabel fresh={fresh} />}

      {panicActive && (
        <div className="banner critical" role="alert" style={{ marginTop: 8 }}>
          <strong>Help requested</strong>
          Your station and nearby officers have your location.
          <button className="btn small block" type="button" style={{ marginTop: 8 }} onClick={async () => {
            await api(`/incidents/${id}/events`, { method: 'POST', body: JSON.stringify({ kind: 'panic_cleared' }) }).catch(() => {});
            setToast('Marked safe.');
          }}>
            I am safe now
          </button>
        </div>
      )}

      {live && (
        <div style={{ margin: '12px 0' }}>
          <MiniMap building={v.building.location} unit={me ?? undefined} label="Map to the building" />
        </div>
      )}

      <div className="card">
        <span className="muted">Brief from the phone and nearby cameras</span>
        <p style={{ margin: '4px 0 0' }}>{v.brief ? v.brief.summary : 'No brief yet. Act on the plain report; the brief follows when ready.'}</p>
      </div>

      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow sub">Address</span>
          <strong>{v.building.address}</strong>
        </div>
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow sub">Reporter</span>
          <strong>
            {v.reporter.label}, trust {v.reporter.trustBand}
          </strong>
        </div>
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow sub">Reports</span>
          <strong>{v.reportCount > 1 ? `${v.reportCount} merged` : '1'}</strong>
        </div>
      </div>

      {primary && (
        <button className="btn block signal" type="button" onClick={primary.run} disabled={busy} style={{ minHeight: 64, fontSize: 'var(--text-lg)', marginBottom: 8 }}>
          {busy ? 'Saving…' : primary.label}
        </button>
      )}
      {live && (
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <button className="btn" type="button" onClick={() => setSheet('note')}>
            Add note
          </button>
          <button className="btn" type="button" onClick={() => setSheet('help')} disabled={!['accepted', 'en_route', 'on_scene'].includes(v.state)}>
            Request help
          </button>
        </div>
      )}
      {live && !panicActive && <PanicButton id={id} onSent={() => setToast('Help requested. Stay safe.')} />}

      {v.rating && (
        <div className="banner success">
          <strong>Rated {v.rating.stars} of 5</strong>
          {v.rating.comment}
        </div>
      )}

      <Attachments ownerType="incident" ownerId={id} refreshKey={v.timeline.filter((e) => /^(Photo|Video) added$/.test(e.label)).length} title="From the reporter" />

      <p className="section-label">Timeline</p>
      <div className="list">
        {[...v.timeline].reverse().slice(0, 12).map((e, i) => (
          <div key={`${e.at}-${i}`} className="row" style={{ cursor: 'default', minHeight: 48 }}>
            <span className="sub" style={{ width: 52, flex: 'none' }}>
              {time(e.at)}
            </span>
            <span className="grow">{e.kind === 'note' ? `Note: ${v.notes.find((n) => n.at === e.at)?.text ?? ''}` : e.label}</span>
          </div>
        ))}
      </div>

      {sheet === 'note' && <TextSheet id={id} kind="note" title="Add note" label="Note for the log" cta="Save note" onClose={() => setSheet(null)} onDone={() => { setSheet(null); setToast('Note saved.'); }} />}
      {sheet === 'help' && <TextSheet id={id} kind="reinforce" title="Request help" label="Say why you need help" cta="Request reinforcement" onClose={() => setSheet(null)} onDone={() => { setSheet(null); setToast('Reinforcement requested.'); }} />}
      {sheet === 'close' && <CloseReportSheet incidentId={id} state={v.state} onClose={() => setSheet(null)} onDone={(m) => { setSheet(null); setToast(m); }} />}
      <Toast msg={toast} />
    </main>
  );
}

/** Officer panic (O-1, MVP): hold for 2 seconds so it never fires by accident. */
function PanicButton({ id, onSent }: { id: string; onSent: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    setHolding(true);
    haptic(20);
    timer.current = setTimeout(async () => {
      setHolding(false);
      haptic([300, 100, 300]);
      await api(`/incidents/${id}/events`, { method: 'POST', body: JSON.stringify({ kind: 'officer_panic' }) }).catch(() => {});
      onSent();
    }, 2000);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    setHolding(false);
  };
  return (
    <button
      className={`btn block panic ${holding ? 'holding' : ''}`}
      type="button"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !holding && start()}
      onKeyUp={stop}
      aria-label="Officer needs help. Press and hold for 2 seconds"
      style={{ marginBottom: 8 }}
    >
      <span className="fill" aria-hidden />
      <span>{holding ? 'Keep holding…' : 'Hold for help'}</span>
    </button>
  );
}

function TextSheet({ id, kind, title, label, cta, onClose, onDone }: { id: string; kind: 'note' | 'reinforce'; title: string; label: string; cta: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet
      open
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!text.trim()) return setErr(kind === 'note' ? 'Write a note before saving.' : 'Say why you need help.');
              setBusy(true);
              try {
                await api(`/incidents/${id}/events`, { method: 'POST', body: JSON.stringify(kind === 'note' ? { kind, text: text.trim() } : { kind, reason: text.trim() }) });
                onDone();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : cta}
          </button>
        </>
      }
    >
      <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
        <span>{label}</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-invalid={!!err} />
      </label>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}
