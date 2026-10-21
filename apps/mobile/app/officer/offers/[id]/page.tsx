'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import { useRouter } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { IncidentMap } from '@erp/web-ui/IncidentMap';
import { api, ApiError, haptic, locate, typeInfo } from '@/lib/client';

interface OfferStatus {
  state: 'offered' | 'accepted' | 'declined' | 'expired' | 'taken' | 'withdrawn';
  secondsLeft: number;
  windowSeconds: number;
  report: { type: string; label: string; postcode: string | null; address: string | null; area: string | null };
  distanceM: number | null;
  takenBy: { name: string; badgeNo: string | null; station: string } | null;
  counted: boolean;
}
interface OfficerView {
  reporter: { trustBand: string };
  building: { address: string; areaLabel: string; postcode: string; location: { lat: number; lng: number } };
  reportCount: number;
  brief?: { summary: string; confidence: string };
  clipIds?: string[];
}

const DECLINE = [
  ['busy', 'Busy on another incident'],
  ['too_far', 'Too far away'],
  ['off_duty', 'Going off duty'],
  ['other', 'Other'],
] as const;
const etaFor = (m: number | null) => (m == null ? undefined : Math.max(1, Math.round((m / 1000 / 30) * 60)));
const TRUST: Record<string, string> = { high: 'success', normal: 'neutral', low: 'warning' };

/** Boards "Officer dispatch offer", "Officer offer expired", "Officer decline reason". */
export default function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [o, setO] = useState<OfferStatus | null | undefined>(undefined);
  const [detail, setDetail] = useState<OfficerView | null>(null);
  const [left, setLeft] = useState(0);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const deadline = useRef(0);

  // The offer's own state, polled: another unit may take it, or the station may pull it.
  useEffect(() => {
    let stop = false;
    let first = true;
    const poll = async () => {
      const x = await api<OfferStatus>(`/incidents/${id}/offer`).catch(() => null);
      if (stop) return;
      setO(x);
      if (x?.state === 'offered') {
        deadline.current = Date.now() + x.secondsLeft * 1000;
        if (first) {
          haptic([200, 100, 200]);
          api<OfficerView>(`/incidents/${id}`).then(setDetail).catch(() => {});
        }
        first = false;
        setTimeout(poll, 2000);
      }
      if (x?.state === 'accepted') router.replace(`/officer/incidents/${id}`);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [id, router]);

  useEffect(() => {
    if (o?.state !== 'offered') return;
    const t = setInterval(() => {
      const s = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        clearInterval(t);
        setO((x) => (x ? { ...x, state: 'expired' } : x));
        // Then ask the server who took it, for the expired screen.
        setTimeout(() => api<OfferStatus>(`/incidents/${id}/offer`).then((x) => x.state !== 'offered' && setO(x)).catch(() => {}), 1500);
      }
    }, 250);
    return () => clearInterval(t);
  }, [o?.state, id]);

  const accept = async () => {
    setBusy(true);
    try {
      await api(`/incidents/${id}/actions`, { method: 'POST', body: JSON.stringify({ event: 'accept', etaMinutes: etaFor(o?.distanceM ?? null) }) });
      haptic([60, 40, 60]);
      router.replace(`/officer/incidents/${id}`);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.status === 409) setO(await api<OfferStatus>(`/incidents/${id}/offer`).catch(() => null));
    }
  };

  if (o === undefined) return <main className="app bare">{<div className="skeleton" style={{ height: 300 }} />}</main>;
  if (!o || o.state !== 'offered') return <Ended o={o} onHome={() => router.replace('/officer')} />;

  const info = typeInfo(o.report.type);
  const pct = Math.max(0, Math.min(1, left / Math.max(1, o.windowSeconds)));
  const hurry = left <= 10;
  const where = detail?.building.address ?? o.report.address;
  return (
    <main className="app bare" style={{ paddingBottom: 120 }}>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--color-surface-raised)', margin: '4px 0 16px', overflow: 'hidden' }} aria-hidden>
        <div style={{ width: `${pct * 100}%`, height: '100%', background: hurry ? 'var(--color-emergency)' : 'var(--color-warning)', transition: 'width 250ms linear' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span className="chip critical" style={{ fontWeight: 800 }}>
          <span className="rec-dot" aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-emergency)', display: 'inline-block', marginRight: 6 }} />
          New incident
        </span>
        <strong role="timer" aria-live="polite" aria-label={`Escalates in ${left} seconds`} style={{ color: hurry ? 'var(--color-emergency-text)' : 'var(--color-warning-text)' }}>
          Escalates in {left} s
        </strong>
      </div>
      <h1 style={{ fontSize: 'var(--text-xxl)', margin: '12px 0 4px' }}>{info.label}</h1>
      <p className="muted" style={{ margin: 0, fontWeight: 600 }}>
        {where ? `${where}, ` : ''}
        {o.report.postcode ? `postcode ${o.report.postcode}` : 'GPS location'}
      </p>
      {detail && (
        <div style={{ margin: '8px 0 12px' }}>
          <IncidentMap incidentId={id} perspective="officer" getPosition={() => locate(5000)} refreshMs={15_000} />
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
          <strong>Brief</strong>
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            {detail?.brief ? `AI summary, ${detail.brief.confidence} confidence` : 'From the report'}
          </span>
        </div>
        <div className="brief-grid">
          <span className="k">Reports</span>
          <strong>{detail ? (detail.reportCount > 1 ? `${detail.reportCount} people reported this` : '1 report') : '…'}</strong>
          <span />
          <span className="k">Summary</span>
          <span>{detail?.brief ? detail.brief.summary : 'No brief yet. It follows when ready; the plain report is enough to go.'}</span>
          <span />
        </div>
        <div style={{ borderTop: '1px solid var(--color-divider)', marginTop: 12, paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted">Reporter trust</span>
          <span className={`chip ${TRUST[detail?.reporter.trustBand ?? ''] ?? 'neutral'}`} style={{ textTransform: 'capitalize' }}>
            {detail?.reporter.trustBand ?? '…'}
          </span>
        </div>
      </div>

      <div className="btn-row">
        <button className="btn" type="button" disabled={!detail?.clipIds?.length} title={detail?.clipIds?.length ? undefined : 'No clips for this report'}>
          Watch clips
        </button>
        <a
          className="btn"
          href={detail ? `https://www.google.com/maps/dir/?api=1&destination=${detail.building.location.lat},${detail.building.location.lng}` : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!detail}
        >
          Open map
        </a>
      </div>

      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 8 }}>
        <button className="btn" type="button" onClick={() => setDeclining(true)} disabled={busy} style={{ minHeight: 64 }}>
          Decline
        </button>
        <button className="btn primary" type="button" onClick={accept} disabled={busy} style={{ minHeight: 64, fontSize: 'var(--text-lg)' }}>
          {busy ? 'Accepting…' : 'Accept'}
        </button>
      </div>

      {declining && <DeclineSheet id={id} onClose={() => setDeclining(false)} onDone={() => router.replace('/officer')} />}
    </main>
  );
}

/** Board "Officer offer expired": what happened, who took it, and that nothing counts against a taken offer. */
function Ended({ o, onHome }: { o: OfferStatus | null; onHome: () => void }) {
  const taken = o?.state === 'taken';
  const declined = o?.state === 'declined';
  return (
    <main className="app bare center" style={{ paddingTop: '18vh', paddingBottom: 140 }}>
      <div className="check" style={{ background: 'var(--color-surface-raised)', color: 'var(--color-text-secondary)', width: 96, height: 96 }}>
        <Icon name="history" size={44} />
      </div>
      <h1 style={{ margin: '16px 0 8px' }}>{declined ? 'You declined this offer' : o?.state === 'withdrawn' ? 'This offer was withdrawn' : 'This offer expired'}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {taken
          ? 'Another unit accepted this report. Nothing was recorded against you.'
          : o?.state === 'withdrawn'
            ? 'The report was cancelled or moved before you answered. Nothing was recorded against you.'
            : declined
              ? 'It went to the next unit.'
              : 'You did not answer in time, so it passed to the next unit.'}
      </p>
      {o && (
        <div className="facts-list" style={{ textAlign: 'left' }}>
          <div>
            <span className="muted">Report</span>
            <strong>{o.report.label}</strong>
          </div>
          {o.takenBy && (
            <div>
              <span className="muted">Taken by</span>
              <strong>
                {o.takenBy.badgeNo ? `${o.takenBy.badgeNo}, ` : `${o.takenBy.name}, `}
                {o.takenBy.station}
              </strong>
            </div>
          )}
        </div>
      )}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
        <button className="btn block signal" type="button" onClick={onHome} style={{ minHeight: 56 }}>
          Back to home
        </button>
        <p className="muted center" style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)' }}>
          Your acceptance rate counts only offers you declined or missed.
        </p>
      </div>
    </main>
  );
}

function DeclineSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet
      open
      title="Why are you declining?"
      onClose={onClose}
      busy={busy}
      footer={
        <div style={{ display: 'grid', gap: 8, width: '100%' }}>
          {err && (
            <span className="field-error" role="alert">
              {err}
            </span>
          )}
          <div className="btn-row">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>
              Go back
            </button>
            <button
              className={`btn ${reason ? 'primary' : ''}`}
              type="button"
              disabled={busy}
              aria-disabled={!reason}
              onClick={async () => {
                if (!reason) return setErr('Choose a reason to continue.');
                setBusy(true);
                try {
                  await api(`/incidents/${id}/decline`, { method: 'POST', body: JSON.stringify({ reason }) });
                  onDone();
                } catch (e) {
                  setErr(e instanceof ApiError ? e.message : 'Could not decline. Try again.');
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Declining…' : 'Decline'}
            </button>
          </div>
          <span className="muted center" style={{ fontSize: 'var(--text-sm)' }}>
            The report goes to the next unit. Declines count in your acceptance rate.
          </span>
        </div>
      }
    >
      <div role="radiogroup" aria-label="Reason">
        {DECLINE.map(([k, l]) => (
          <button
            key={k}
            className="choice"
            type="button"
            role="radio"
            aria-checked={reason === k}
            aria-pressed={reason === k}
            onClick={() => (setReason(k), setErr(null))}
            style={{ minHeight: 60, border: '1px solid var(--color-divider)', background: reason === k ? 'var(--color-emergency-soft)' : 'var(--color-bg)' }}
          >
            <span className="radio-dot" data-on={reason === k} />
            <strong>{l}</strong>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
