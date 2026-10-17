'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, haptic, locate, TYPES, typeInfo, uid, type TypeCode } from '@/lib/client';
import { sendReport, smsHref, type QueuedReport } from '@/lib/outbox';

interface Place {
  isHome: boolean;
  postcode: string;
  address: string;
}
type Where = { kind: 'home'; postcode: string; label: string } | { kind: 'here'; lat: number; lng: number } | { kind: 'postcode'; postcode: string };

const RING_S = 5;
const C = 2 * Math.PI * 90;

function Report() {
  const router = useRouter();
  const params = useSearchParams();
  const type = params.get('type') as TypeCode | null;
  const [home, setHome] = useState<Place | null>(null);
  const [where, setWhere] = useState<Where | null>(null);
  const [discreet, setDiscreet] = useState(false);
  const [lowTrust, setLowTrust] = useState(false);
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<'confirm' | 'sending' | 'ring' | 'queued' | 'cancelled'>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(RING_S);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedReport | null>(null);
  const started = useRef(0);

  useEffect(() => {
    api<Place[]>('/me/places')
      .then((p) => {
        const h = p.find((x) => x.isHome) ?? null;
        setHome(h);
        setWhere((w) => w ?? (h ? { kind: 'home', postcode: h.postcode, label: h.address } : null));
      })
      .catch(() => {});
    api<{ preferences: { discreetMode: boolean }; trust: { band: string } }>('/me')
      .then((m) => {
        setDiscreet(m.preferences.discreetMode);
        setLowTrust(m.trust.band === 'low');
      })
      .catch(() => {});
  }, []);

  // No saved home: use where the phone is.
  useEffect(() => {
    if (where || home) return;
    void locate().then((p) => p && setWhere({ kind: 'here', ...p }));
  }, [where, home]);

  // The ring mirrors the server's cancel window; when it ends the report is live.
  useEffect(() => {
    if (phase !== 'ring' || !incidentId) return;
    let last = RING_S;
    const t = setInterval(() => {
      const remaining = Math.max(0, RING_S - Math.floor((Date.now() - started.current) / 1000));
      setLeft(remaining);
      // One haptic tick per second of the countdown.
      if (remaining !== last && remaining > 0) haptic(15);
      last = remaining;
      if (remaining === 0) {
        clearInterval(t);
        router.replace(`/reports/${incidentId}`);
      }
    }, 250);
    return () => clearInterval(t);
  }, [phase, incidentId, router]);

  if (!type) return <TypePicker />;
  const info = typeInfo(type);

  const confirm = async () => {
    setError(null);
    if (!where) {
      setError('Turn on location so help can find you, or type your postcode.');
      return;
    }
    haptic(40);
    setPhase('sending');
    const r: QueuedReport = {
      clientRef: uid(),
      type,
      discreet,
      savedAt: new Date().toISOString(),
      ...(where.kind === 'here' ? { lat: where.lat, lng: where.lng } : { postcode: where.postcode }),
    };
    try {
      const out = await sendReport(r);
      if (!out) {
        setQueued(r);
        setPhase('queued');
        return;
      }
      started.current = Date.now();
      setLeft(RING_S);
      setIncidentId(out.id);
      setPhase('ring');
    } catch (e) {
      setPhase('confirm');
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  };

  const cancel = async () => {
    if (!incidentId) return;
    try {
      await api(`/incidents/${incidentId}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'mistake' }) });
      setPhase('cancelled');
    } catch (e) {
      // The window just closed: the report is live, so go to its status.
      router.replace(`/reports/${incidentId}`);
    }
  };

  if (phase === 'cancelled') {
    return (
      <main className="app bare center">
        <div className="check">
          <Icon name="check" size={44} />
        </div>
        <h1>Report cancelled</h1>
        <p className="muted">No one will be sent. Nothing was recorded against you.</p>
        <Link href="/home" className="btn block signal">
          Back to Home
        </Link>
      </main>
    );
  }

  if (phase === 'queued' && queued) {
    return (
      <main className="app bare">
        <Header title="No connection" back="/home" />
        <div className="banner warning">
          <strong>Your report is saved</strong>
          We will keep trying and send it as soon as you are back online. You can also send it by SMS now.
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <a className="btn block primary" href={smsHref(queued)}>
            Send by SMS now
          </a>
          <a className="btn block" href="tel:112">
            <Icon name="phone" /> Call 112
          </a>
        </div>
      </main>
    );
  }

  if (phase === 'ring') {
    const off = C * (1 - left / RING_S);
    return (
      <main className="app bare center">
        <p className="section-label" style={{ marginTop: 32 }}>
          Sending {info.label.toLowerCase()} report
        </p>
        <div className="ring" role="timer" aria-live="assertive" aria-label={`Sending in ${left} seconds`}>
          <svg viewBox="0 0 200 200" width="200" height="200" aria-hidden>
            <circle className="track" cx="100" cy="100" r="90" fill="none" strokeWidth="10" />
            <circle className="bar" cx="100" cy="100" r="90" fill="none" strokeWidth="10" strokeDasharray={C} strokeDashoffset={off} />
          </svg>
          <div className="count">
            {left}
            <small>seconds</small>
          </div>
        </div>
        <p className="muted">Tap Cancel if this was a mistake. After that, help is on the way.</p>
        <button className="btn block" type="button" onClick={cancel} style={{ marginTop: 16 }}>
          Cancel
        </button>
      </main>
    );
  }

  const whereText =
    where?.kind === 'home' ? `Home, ${where.label} · ${where.postcode}` : where?.kind === 'postcode' ? `Postcode ${where.postcode}` : where ? 'Where you are now (GPS)' : 'Finding your location…';

  return (
    <main className="app bare">
      <Header title="Confirm report" back="/report" />
      <div className="tiles" style={{ gridTemplateColumns: '1fr' }}>
        <div className="tile" aria-pressed="true" style={{ minHeight: 120 }}>
          <Icon name={type} size={40} />
          <span style={{ fontSize: 'var(--text-lg)' }}>{info.label}</span>
        </div>
      </div>

      <div className="list" style={{ marginTop: 12 }}>
        <button className="row" type="button" onClick={() => setEditing(true)}>
          <Icon name="pin" />
          <span className="grow">
            <strong>{whereText}</strong>
            <span className="sub">Location</span>
          </span>
          <span className="link-btn">Edit</span>
        </button>
        <div className="row" style={{ cursor: 'default' }}>
          <Icon name="shield" />
          <span className="grow">
            <strong>{info.agency}</strong>
            <span className="sub">Sending to</span>
          </span>
        </div>
      </div>

      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {lowTrust && (
        <div className="banner warning">
          False alarms can cost a fine. Send only real emergencies.
        </div>
      )}

      <button className="btn block primary" type="button" onClick={confirm} disabled={phase === 'sending'} style={{ minHeight: 72, fontSize: 'var(--text-lg)', marginTop: 8 }}>
        {phase === 'sending' ? 'Sending…' : 'Confirm and send'}
      </button>
      <p className="muted center">False alarms delay real help. You can cancel for 5 seconds after sending.</p>

      <WhereSheet
        open={editing}
        home={home}
        onClose={() => setEditing(false)}
        onPick={(w) => {
          setWhere(w);
          setEditing(false);
        }}
      />
    </main>
  );
}

function TypePicker() {
  return (
    <main className="app bare">
      <Header title="What is happening?" back="/home" />
      <div className="tiles" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {TYPES.map((t) => (
          <Link key={t.code} href={`/report?type=${t.code}`} className="tile" style={{ minHeight: 96 }}>
            <Icon name={t.code} size={30} />
            {t.label}
          </Link>
        ))}
      </div>
      <p className="muted center" style={{ marginTop: 16 }}>
        Not an emergency? <Link href="/tips">Report a tip</Link> instead.
      </p>
    </main>
  );
}

function WhereSheet({ open, home, onClose, onPick }: { open: boolean; home: Place | null; onClose: () => void; onPick: (w: Where) => void }) {
  const [postcode, setPostcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const here = async () => {
    setBusy(true);
    setErr(null);
    const p = await locate();
    setBusy(false);
    if (p) onPick({ kind: 'here', ...p });
    else setErr('Turn on location so help can find you, or type your postcode.');
  };
  const typed = async () => {
    setErr(null);
    setBusy(true);
    try {
      const b = await api<{ postcode: string }>(`/places/lookup?postcode=${encodeURIComponent(postcode)}`);
      onPick({ kind: 'postcode', postcode: b.postcode });
    } catch (e) {
      // Postcode service down: GPS still works, so offer it (States doc).
      setErr(e instanceof ApiError ? e.message : 'Check the postcode.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="Where is it happening?"
      onClose={onClose}
      busy={busy}
      footer={
        <button className="btn" type="button" onClick={onClose}>
          Keep current
        </button>
      }
    >
      {home && (
        <button className="btn block" type="button" onClick={() => onPick({ kind: 'home', postcode: home.postcode, label: home.address })}>
          <Icon name="home" /> Home, {home.address}
        </button>
      )}
      <button className="btn block" type="button" onClick={here} disabled={busy}>
        <Icon name="pin" /> Where I am now
      </button>
      <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
        <span>Or type a postcode</span>
        <input className="input" value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="AB 12 C" autoCapitalize="characters" inputMode="text" />
      </label>
      {err && <span className="field-error">{err}</span>}
      <button className="btn block signal" type="button" onClick={typed} disabled={busy || postcode.trim().length < 3}>
        Use this postcode
      </button>
    </Sheet>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Report />
    </Suspense>
  );
}
