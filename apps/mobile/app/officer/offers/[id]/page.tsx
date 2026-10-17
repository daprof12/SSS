'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import { useRouter } from 'next/navigation';
import { use, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, haptic, typeInfo } from '@/lib/client';

interface Offer {
  id: string;
  type: string;
  postcode: string | null;
  area_label: string;
  distance_m: number | null;
  secondsLeft: number;
}
interface OfficerView {
  reporter: { trustBand: string };
  building: { address: string; areaLabel: string };
  reportCount: number;
  brief?: { summary: string; confidence: string };
}

const C = 2 * Math.PI * 90;
const DECLINE = [
  ['busy', 'Busy'],
  ['too_far', 'Too far'],
  ['off_duty', 'Off duty'],
  ['other', 'Other'],
] as const;
const etaFor = (m: number | null) => (m == null ? undefined : Math.max(1, Math.round((m / 1000 / 30) * 60)));

/** Dispatch offer (Wireframe 4; boards "Officer dispatch offer", "offer expired", "decline reason"). */
export default function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);
  const [detail, setDetail] = useState<OfficerView | null>(null);
  const [left, setLeft] = useState(0);
  const [total, setTotal] = useState(25);
  const [ended, setEnded] = useState<'expired' | 'taken' | null>(null);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const deadline = useRef(0);

  useEffect(() => {
    void (async () => {
      const home = await api<{ tabs: { offers: { items: Offer[] } } }>('/me/officer/home').catch(() => null);
      const o = home?.tabs.offers.items.find((x) => x.id === id) ?? null;
      setOffer(o);
      if (!o) return setEnded('expired');
      deadline.current = Date.now() + o.secondsLeft * 1000;
      setLeft(o.secondsLeft);
      setTotal(Math.max(o.secondsLeft, 1));
      haptic([200, 100, 200]);
      api<OfficerView>(`/incidents/${id}`).then(setDetail).catch(() => {});
    })();
  }, [id]);

  useEffect(() => {
    if (!offer || ended) return;
    const t = setInterval(() => {
      const s = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) {
        clearInterval(t);
        setEnded('expired');
      }
    }, 250);
    return () => clearInterval(t);
  }, [offer, ended]);

  const accept = async () => {
    setBusy(true);
    try {
      await api(`/incidents/${id}/actions`, { method: 'POST', body: JSON.stringify({ event: 'accept', etaMinutes: etaFor(offer?.distance_m ?? null) }) });
      haptic([60, 40, 60]);
      router.replace(`/officer/incidents/${id}`);
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && (e.code === 'offer_expired' || e.status === 409)) setEnded(e.message.includes('Another') ? 'taken' : 'expired');
    }
  };

  if (ended) {
    return (
      <main className="app bare center">
        <div className="check" style={{ background: 'var(--color-surface-raised)', color: 'var(--color-text-secondary)' }}>
          <Icon name="history" size={40} />
        </div>
        <h1>{ended === 'taken' ? 'Taken by another unit' : 'Offer expired'}</h1>
        <p className="muted">{ended === 'taken' ? 'Another unit accepted this report.' : 'This offer expired and passed to the next team. Nothing was recorded against you.'}</p>
        <button className="btn block signal" type="button" onClick={() => router.replace('/officer')}>
          Back to Home
        </button>
      </main>
    );
  }
  if (!offer) return <main className="app bare">{offer === undefined && <div className="skeleton" style={{ height: 300 }} />}</main>;

  const info = typeInfo(offer.type);
  const cls = left <= 5 ? 'last' : left <= 10 ? 'hurry' : '';
  const eta = etaFor(offer.distance_m);
  return (
    <main className="app bare offer">
      <Header back="/officer" />
      <div className="kicker">NEW INCIDENT</div>
      <h1>{info.label}</h1>
      <p style={{ margin: 0, fontWeight: 700 }}>
        {offer.postcode ?? 'GPS location'}, {offer.area_label}
      </p>
      <p className="muted" style={{ marginTop: 4 }}>
        {offer.distance_m != null ? `${(offer.distance_m / 1000).toFixed(1)} km` : ''}
        {eta ? ` · about ${eta} min` : ''}
      </p>

      <div className={`ring offer-ring ${cls}`} role="timer" aria-live="polite" aria-label={`${left} seconds to accept`} style={{ width: 160, height: 160 }}>
        <svg viewBox="0 0 200 200" width="160" height="160" aria-hidden>
          <circle className="track" cx="100" cy="100" r="90" fill="none" strokeWidth="12" />
          <circle className="bar" cx="100" cy="100" r="90" fill="none" strokeWidth="12" strokeDasharray={C} strokeDashoffset={C * (1 - left / total)} />
        </svg>
        <div className="count" style={{ fontSize: 44 }}>
          {left}
          <small>to accept</small>
        </div>
      </div>

      <div className="card" style={{ textAlign: 'left' }}>
        <div className="row" style={{ padding: 0, minHeight: 40 }}>
          <span className="grow">
            <span className="sub">Reporter trust</span>
          </span>
          <span className={`chip ${detail?.reporter.trustBand === 'high' ? 'success' : detail?.reporter.trustBand === 'low' ? 'warning' : 'neutral'}`} style={{ textTransform: 'capitalize' }}>
            {detail?.reporter.trustBand ?? '…'}
          </span>
        </div>
        {detail && detail.reportCount > 1 && <p style={{ margin: '8px 0 0' }}>{detail.reportCount} people reported this.</p>}
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {detail?.brief ? detail.brief.summary : 'No brief yet. It follows when ready; the plain report is enough to go.'}
        </p>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <button className="btn block signal" type="button" onClick={accept} disabled={busy} style={{ minHeight: 72, fontSize: 'var(--text-lg)' }}>
          {busy ? 'Accepting…' : 'Accept'}
        </button>
        <button className="btn block" type="button" onClick={() => setDeclining(true)} disabled={busy}>
          Decline
        </button>
      </div>

      {declining && <DeclineSheet id={id} onClose={() => setDeclining(false)} onDone={() => router.replace('/officer')} />}
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
      description="The report goes straight to the next officer."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Back to the offer
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!reason) return setErr('A reason is required: busy, too far, off duty, other.');
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
            Decline offer
          </button>
        </>
      }
    >
      <div className="chips" role="group" aria-label="Reason">
        {DECLINE.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={reason === k} onClick={() => setReason(k)}>
            {l}
          </button>
        ))}
      </div>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}
