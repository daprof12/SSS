'use client';
// "Offer alerts" for this phone: turn on push so offers and assignments arrive with the app closed,
// send a test, or turn it off. `compact` is the home-screen nudge shown only while alerts are off.
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/client';
import { pushState, turnOffPush, turnOnPush, type PushState } from '@/lib/push';

const WHY: Partial<Record<PushState, string>> = {
  needs_install: 'On iPhone, add ERP to your Home Screen first: tap Share, then Add to Home Screen. Open ERP from there and turn alerts on.',
  unsupported: 'This browser cannot show alerts. Use Chrome on Android, or ERP from your Home Screen on iPhone.',
  blocked: 'Alerts are blocked for ERP. Allow notifications for this app in your phone settings, then come back.',
  off_on_server: 'Alerts are not set up on this server yet.',
};

export function AlertsCard({ compact }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    pushState()
      .then(setState)
      .catch(() => setState('unsupported'));
  }, []);
  const run = async (fn: () => Promise<PushState | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await fn();
      if (next) setState(next);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not change alerts. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  if (compact) {
    if (state === 'on' || state === 'off_on_server') return null;
    return (
      <div className="banner warning" role="status">
        <strong>Turn on offer alerts</strong>
        {WHY[state] ?? 'So offers reach you when the app is closed. Without them you only see offers with ERP open.'}
        {state === 'off' && (
          <button className="btn small block primary" type="button" disabled={busy} style={{ marginTop: 8 }} onClick={() => void run(turnOnPush)}>
            {busy ? 'Turning on…' : 'Turn on alerts'}
          </button>
        )}
        {msg && <span className="field-error">{msg}</span>}
      </div>
    );
  }
  return (
    <section className="card" aria-labelledby="alerts" style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
      <strong id="alerts">Alerts on this phone</strong>
      <span className="muted">
        {state === 'on' ? 'On. Offers and assignments ring this phone even when ERP is closed.' : (WHY[state] ?? 'Off. Turn on so offers reach you when ERP is closed.')}
      </span>
      {state === 'off' && (
        <button className="btn block primary" type="button" disabled={busy} onClick={() => void run(turnOnPush)}>
          {busy ? 'Turning on…' : 'Turn on alerts'}
        </button>
      )}
      {state === 'on' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn"
            type="button"
            disabled={busy}
            style={{ flex: 1 }}
            onClick={() => void run(async () => setMsg((await api<{ message: string }>('/me/push/test', { method: 'POST', body: '{}' })).message))}
          >
            Send a test
          </button>
          <button className="btn" type="button" disabled={busy} style={{ flex: 1 }} onClick={() => void run(turnOffPush)}>
            Turn off
          </button>
        </div>
      )}
      {msg && (
        <span className="muted" role="status">
          {msg}
        </span>
      )}
    </section>
  );
}
