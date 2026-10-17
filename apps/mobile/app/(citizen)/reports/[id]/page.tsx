'use client';

import { timelineSteps } from '@erp/domain';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { MiniMap } from '@/components/MiniMap';
import { api, ApiError, haptic, typeInfo } from '@/lib/client';
import { FreshLabel, useIncident } from '@/lib/useIncident';

interface LatLng {
  lat: number;
  lng: number;
}
interface CitizenView {
  id: string;
  type: string;
  state: string;
  view: 'reporter' | 'joiner';
  reportCount: number;
  building?: { postcode: string; address: string; location?: LatLng };
  area?: string;
  officer?: { name: string; badgeNo: string; stationName: string; rating: number };
  officerLocation?: LatLng;
  etaMinutes?: number;
  mergedInto?: string;
  myRating?: { stars: number };
  status: { title: string; line: string; step: number; actions: string[]; showOfficerCard: boolean; showLiveMap: boolean; tone: string };
}

const CANCEL_REASONS = [
  ['mistake', 'Sent by mistake'],
  ['resolved_myself', 'It is over now'],
  ['help_arrived_other', 'Other help arrived'],
  ['unsafe_to_wait', 'I had to leave'],
  ['other', 'Other'],
] as const;

/** Live status (Wireframe 3, Report Tracking §A3): status first, map, timeline, officer, actions. */
export default function LiveStatus({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { view: v, gone, fresh } = useIncident<CitizenView>(id);
  const [sheet, setSheet] = useState<'cancel' | 'info' | null>(null);
  const [toast, setToast] = useToast();
  const lastState = useRef<string | null>(null);

  // Merged into another report: follow that one (one shared timeline).
  useEffect(() => {
    if (v?.mergedInto) router.replace(`/reports/${v.mergedInto}`);
  }, [v?.mergedInto, router]);

  // Success buzz when help accepts (Design Brief: haptics).
  useEffect(() => {
    if (!v) return;
    if (lastState.current && lastState.current !== 'accepted' && v.state === 'accepted') haptic([60, 40, 60]);
    lastState.current = v.state;
  }, [v]);

  if (gone) {
    return (
      <main className="app bare">
        <Header back="/activity" />
        <div className="card empty">
          <strong>{gone}</strong>
          <Link href="/activity">See your reports</Link>
        </div>
      </main>
    );
  }
  if (!v) {
    return (
      <main className="app bare">
        <div className="skeleton" style={{ height: 260 }} />
        <div className="skeleton" style={{ height: 40, width: '60%' }} />
        <div className="skeleton" style={{ height: 120 }} />
      </main>
    );
  }

  const s = v.status;
  const info = typeInfo(v.type);
  const live = !['resolved', 'unfounded', 'cancelled', 'merged'].includes(v.state);
  const steps = timelineSteps;

  return (
    <main className="app bare" style={{ paddingTop: 0 }}>
      {s.showLiveMap ? (
        <div style={{ position: 'relative' }}>
          <MiniMap building={v.building?.location} unit={v.officerLocation} label="Map of your location and the responding unit" />
          <button className="back" type="button" aria-label="Back" onClick={() => router.push('/home')} style={{ position: 'absolute', top: 16, left: 0 }}>
            <Icon name="back" />
          </button>
          <span className="chip critical" style={{ position: 'absolute', top: 24, right: 0 }}>
            {info.label}, {live ? 'live' : 'closed'}
          </span>
        </div>
      ) : (
        <div style={{ paddingTop: 16 }}>
          <Header back="/home">
            <span className={`chip ${live ? 'critical' : 'neutral'}`}>
              {info.label}, {live ? 'live' : 'closed'}
            </span>
          </Header>
        </div>
      )}

      <div className="status-head">
        <div>
          <span className="muted">Status</span>
          <h1>{s.title}</h1>
        </div>
        {v.etaMinutes != null && live && (
          <div className="eta">
            <small>Arrives in</small>
            <strong>{v.etaMinutes} min</strong>
          </div>
        )}
      </div>
      <p style={{ margin: '6px 0 4px' }}>{s.line}</p>
      {live && <FreshLabel fresh={fresh} />}

      {s.step >= 0 && (
        <ol className="steps" aria-label="Progress">
          {steps.map((label, i) => (
            <li key={label} className={i < s.step ? 'done' : i === s.step ? (v.state === 'resolved' ? 'done' : 'now') : ''} aria-current={i === s.step ? 'step' : undefined}>
              <i aria-hidden />
              {label}
            </li>
          ))}
        </ol>
      )}

      {v.reportCount > 1 && (
        <div className="banner success">
          <strong>
            You and {v.reportCount - 1 === 1 ? '1 other person' : `${v.reportCount - 1} others`} reported this
          </strong>
          One response is on its way for everyone.
        </div>
      )}

      {s.showOfficerCard && v.officer && (
        <div className="officer-card">
          <span className="avatar" aria-hidden>
            <Icon name="user" />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ display: 'block' }}>{v.officer.name}</strong>
            <span className="muted">
              {v.officer.stationName}, badge {v.officer.badgeNo}
            </span>
          </span>
          <span className="chip success">
            <Icon name="check" size={14} /> Badge verified
          </span>
        </div>
      )}

      {s.actions.includes('rate') && !v.myRating && (
        <Link href={`/reports/${id}/rate`} className="btn block signal" style={{ marginBottom: 8 }}>
          Rate the response
        </Link>
      )}
      {v.myRating && <div className="banner success">You rated this response {v.myRating.stars} out of 5. Thank you.</div>}

      {(s.actions.includes('call') || s.actions.includes('message')) && (
        <>
          <div className="btn-row" style={{ marginBottom: 6 }}>
            <button className="btn signal" type="button" disabled>
              <Icon name="phone" /> Call
            </button>
            <button className="btn" type="button" disabled>
              <Icon name="message" /> Message
            </button>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Calls and messages go through a protected line so numbers stay private. Coming next.
          </p>
        </>
      )}

      {s.actions.includes('add_info') && (
        <button className="btn block" type="button" onClick={() => setSheet('info')} style={{ marginBottom: 8 }}>
          Add info
        </button>
      )}
      {s.actions.includes('call_112') && (
        <a className="btn block" href="tel:112" style={{ marginBottom: 8 }}>
          <Icon name="phone" /> Call 112
        </a>
      )}
      {s.actions.includes('share_contacts') && (
        <Link className="btn block" href="/profile/contacts" style={{ marginBottom: 8 }}>
          <Icon name="contacts" /> Emergency contacts
        </Link>
      )}
      {s.actions.includes('cancel') && (
        <button className="link-btn" type="button" onClick={() => setSheet('cancel')} style={{ display: 'block', margin: '8px auto 0' }}>
          Cancel report
        </button>
      )}
      {live && <p className="muted center">Add a photo or voice note only if it is safe. It is optional.</p>}

      {sheet === 'cancel' && (
        <CancelSheet
          id={id}
          state={v.state}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            setToast('Report cancelled.');
          }}
        />
      )}
      {sheet === 'info' && (
        <InfoSheet
          id={id}
          onClose={() => setSheet(null)}
          onDone={() => {
            setSheet(null);
            setToast('Sent to the team.');
          }}
        />
      )}
      <Toast msg={toast} />
    </main>
  );
}

function CancelSheet({ id, state, onClose, onDone }: { id: string; state: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dispatched = state !== 'received';
  return (
    <Sheet
      open
      title="Cancel this report?"
      description="Only cancel if you no longer need help."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Keep my report
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!reason) return setErr('Choose a reason.');
              setBusy(true);
              try {
                await api(`/incidents/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
                onDone();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not cancel. Try again.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Cancelling…' : 'Cancel report'}
          </button>
        </>
      }
    >
      {dispatched && (
        <div className="banner warning" style={{ margin: 0 }}>
          Officers may already be on the way. Cancelling is recorded, but you are never blocked from cancelling.
        </div>
      )}
      <div className="chips" role="group" aria-label="Reason">
        {CANCEL_REASONS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={reason === k} onClick={() => setReason(k)}>
            {l}
          </button>
        ))}
      </div>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}

function InfoSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet
      open
      title="Add info"
      description="Anything that helps the team: people, vehicles, which entrance. Only if it is safe."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!text.trim()) return setErr('Write something before sending.');
              setBusy(true);
              try {
                await api(`/incidents/${id}/events`, { method: 'POST', body: JSON.stringify({ kind: 'add_info', text: text.trim() }) });
                onDone();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Sending…' : 'Send to the team'}
          </button>
        </>
      }
    >
      <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
        <span>What should they know?</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-invalid={!!err} />
      </label>
      <span className="muted">{text.length > 450 ? `${500 - text.length} characters left` : 'Photos and voice notes come next.'}</span>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}
