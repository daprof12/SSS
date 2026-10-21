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
import { Attachments, AttachPicker, uploadPicked, usePicked } from '@/components/reports/Attach';

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
  timeline: Array<{ at: string; kind: string; label: string; by?: string }>;
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
  const [sheet, setSheet] = useState<'note' | 'help' | 'close' | 'transfer' | 'drone' | null>(null);
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
    null;

  return (
    <main className="app bare">
      <Header title={`${info.label}, ${v.building.postcode || 'GPS'}`} back="/officer">
        <StateChip state={v.state} />
      </Header>
      {live && <FreshLabel fresh={fresh} />}
      {live && (
        <div className="stage-strip" aria-label="Stage">
          {(['en_route', 'on_scene', 'closing'] as const).map((k, i) => {
            const order = ['accepted', 'en_route', 'on_scene', 'closing'];
            const at = order.indexOf(v.state);
            const mine = order.indexOf(k);
            return (
              <span key={k} data-on={v.state === k || (k === 'en_route' && v.state === 'accepted')} data-done={mine < at} aria-current={v.state === k ? 'step' : undefined}>
                {['En route', 'On scene', 'Close'][i]}
              </span>
            );
          })}
        </div>
      )}

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
            Add note or photo
          </button>
          <button className="btn" type="button" onClick={() => setSheet('drone')} disabled={!['accepted', 'en_route', 'on_scene'].includes(v.state)}>
            Request drone
          </button>
        </div>
      )}
      {live && (
        <div className="btn-row" style={{ marginBottom: 8, gridTemplateColumns: '1fr 1fr 1fr', display: 'grid' }}>
          <button className="btn" type="button" onClick={() => setSheet('help')} disabled={!['accepted', 'en_route', 'on_scene'].includes(v.state)} style={{ background: 'var(--color-signal)', color: '#031016' }}>
            Reinforce
          </button>
          <button className="btn" type="button" onClick={() => setSheet('transfer')}>
            Transfer
          </button>
          <button className="btn primary" type="button" onClick={() => setSheet('close')} disabled={!['on_scene', 'closing'].includes(v.state)}>
            Close
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

      <div className="card">
        <h2 style={{ margin: '0 0 4px', fontSize: 'var(--text-lg)' }}>Response log</h2>
        <ol className="timeline-list">
          {v.timeline.slice(-20).map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <time>{time(e.at)}</time>
              <span style={{ display: 'grid' }}>
                <strong>{e.kind === 'note' ? `Note: ${v.notes.find((n) => n.at === e.at)?.text ?? ''}` : e.label}</strong>
                {e.by && <span className="muted">{e.by}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {sheet === 'note' && <NoteSheet id={id} onClose={() => setSheet(null)} onDone={(m) => { setSheet(null); setToast(m); }} />}
      {sheet === 'drone' && <TextSheet id={id} kind="drone_requested" title="Request a drone" label="What should it look for? (optional)" cta="Request drone" optional onClose={() => setSheet(null)} onDone={() => { setSheet(null); setToast('Drone requested. Your station head decides.'); }} />}
      {sheet === 'transfer' && (['accepted', 'en_route'].includes(v.state)
        ? <HandOverSheet id={id} onClose={() => setSheet(null)} onDone={(m) => { setSheet(null); setToast(m); }} />
        : <TextSheet id={id} kind="transfer_requested" title="Ask to transfer" label="Why should another unit or station take it?" cta="Ask the station" onClose={() => setSheet(null)} onDone={() => { setSheet(null); setToast('Asked. Your station head moves the report.'); }} />)}
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

function TextSheet({ id, kind, title, label, cta, optional, onClose, onDone }: { id: string; kind: 'reinforce' | 'drone_requested' | 'transfer_requested'; title: string; label: string; cta: string; optional?: boolean; onClose: () => void; onDone: () => void }) {
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
              if (!optional && !text.trim()) return setErr(kind === 'reinforce' ? 'Say why you need help.' : 'Say why it should move.');
              setBusy(true);
              try {
                await api(`/incidents/${id}/events`, { method: 'POST', body: JSON.stringify({ kind, reason: text.trim() || undefined }) });
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

/** "Add note or photo": a note for the log and/or photos, kept in the staff log (not shown to the reporter). */
function NoteSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (m: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const picked = usePicked();
  const save = async () => {
    if (!text.trim() && !picked.items.length) return setErr('Write a note or add a photo.');
    setBusy(true);
    try {
      if (text.trim()) await api(`/incidents/${id}/events`, { method: 'POST', body: JSON.stringify({ kind: 'note', text: text.trim() }) });
      const failed = picked.items.length ? await uploadPicked('incident', id, picked) : 0;
      if (failed) {
        setErr(`${failed} ${failed === 1 ? 'file' : 'files'} did not upload. Try again.`);
        return setBusy(false);
      }
      onDone(picked.items.length ? 'Saved to the log.' : 'Note saved.');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Add note or photo"
      description="For the response log. The reporter does not see these."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn signal" type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label className="field" data-invalid={!!err} style={{ marginBottom: 12 }}>
        <span>Note</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-invalid={!!err} />
      </label>
      <AttachPicker picked={picked} disabled={busy} />
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}

const HAND_OVER = [
  ['vehicle', 'Vehicle problem'],
  ['specialist', 'Needs a specialist unit'],
  ['safety', 'Not safe to go alone'],
  ['other', 'Other'],
] as const;

/** Before arriving: hand the report back so the next nearest unit gets it (officer_drop). */
function HandOverSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet
      open
      title="Hand over to another unit?"
      description="The report goes to the next nearest unit at once, and the reporter is told a new team is coming."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!reason) return setErr('Choose a reason to continue.');
              setBusy(true);
              try {
                await api(`/incidents/${id}/actions`, { method: 'POST', body: JSON.stringify({ event: 'officer_drop', reason: HAND_OVER.find(([k]) => k === reason)![1] }) });
                onDone('Handed over. The next unit is being found.');
                window.location.href = '/officer';
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not hand over. Try again.');
                setBusy(false);
              }
            }}
          >
            Hand over
          </button>
        </>
      }
    >
      <div className="chips" role="radiogroup" aria-label="Reason">
        {HAND_OVER.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={reason === k} aria-pressed={reason === k} onClick={() => (setReason(k), setErr(null))}>
            {l}
          </button>
        ))}
      </div>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}
