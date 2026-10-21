'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { PinPad, ResetPin } from '@/components/WithdrawFlow';
import { api, ApiError } from '@/lib/client';

interface Security {
  twoStep: { on: boolean; required: boolean; method: string };
  pin: { set: boolean; digits: number };
  biometrics: { on: boolean; openApp: boolean; payments: boolean; signing: boolean };
  trustedDevices: number;
  sessions: { total: number; others: number };
  recoveryCodes: { left: number; generated: boolean };
}
interface Session {
  id: string;
  label: string;
  platform: string | null;
  lastSeen: string;
  current: boolean;
}
interface Device {
  id: string;
  label: string;
  platform: string;
  lastSeen: string | null;
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not used yet');

/** Board "Profile security 2FA, PIN, face": same settings for citizens, officers, agencies and admins. */
export default function SecurityPage() {
  const [s, setS] = useState<Security | null>(null);
  const [sheet, setSheet] = useState<'2fa' | '2fa-off' | 'codes' | 'pin' | 'reset' | 'sessions' | 'devices' | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [toast, setToast] = useToast();
  const load = () => api<Security>('/me/security').then(setS).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  const bio = async (patch: Partial<Record<'on' | 'openApp' | 'signing', boolean>>) => {
    if (patch.on && typeof window !== 'undefined' && !('PublicKeyCredential' in window)) {
      return setToast('This phone has no face or fingerprint unlock we can use.');
    }
    setS((x) => (x ? { ...x, biometrics: { ...x.biometrics, ...patch } } : x));
    await api('/me/security/biometrics', { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {
      setToast('Could not save. Try again.');
      void load();
    });
  };
  const done = (m: string, shown?: string[]) => {
    setSheet(null);
    setToast(m);
    if (shown) setCodes(shown);
    void load();
  };

  return (
    <main className="app">
      <Header title="Security" back="/profile" />
      {s && !s.twoStep.on && (
        <button className="banner warning" type="button" onClick={() => setSheet('2fa')} style={{ display: 'flex', width: '100%', textAlign: 'left', border: 0, alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>
            <strong>Turn on two-step login</strong>
            Required for officers, agency staff and admins. Recommended for everyone, needed to withdraw money.
          </span>
          <strong>Set up</strong>
        </button>
      )}

      <p className="section-label">Sign in</p>
      <div className="list">
        <button className="row" type="button" onClick={() => setSheet(s?.twoStep.on ? '2fa-off' : '2fa')}>
          <span className="grow">
            <strong>Two-step login (2FA)</strong>
            <span className="sub">{s?.twoStep.required ? 'Required for your role' : 'A code by SMS when you sign in on a new phone'}</span>
          </span>
          <strong style={{ color: s?.twoStep.on ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{s ? (s.twoStep.on ? 'On' : 'Off') : ''}</strong>
        </button>
        <button className="row" type="button" onClick={() => setSheet('pin')}>
          <span className="grow">
            <strong>PIN</strong>
            <span className="sub">{s?.pin.digits ?? 4} digits, asked for payments, withdrawals and signing</span>
          </span>
          <strong style={{ color: s?.pin.set ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{s ? (s.pin.set ? 'Change' : 'Set') : ''}</strong>
        </button>
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Face or fingerprint</strong>
            <span className="sub">Uses your phone. Not stored by us</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={!!s?.biometrics.on} aria-label="Face or fingerprint" onClick={() => s && bio({ on: !s.biometrics.on })} />
        </div>
      </div>

      {s?.biometrics.on && (
        <>
          <p className="section-label">Use face or fingerprint for</p>
          <div className="list">
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>Opening the app</strong>
              </span>
              <button className="toggle" type="button" role="switch" aria-checked={s.biometrics.openApp} aria-label="Opening the app" onClick={() => bio({ openApp: !s.biometrics.openApp })} />
            </div>
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>Withdrawals and payments</strong>
                <span className="sub">Always asks, cannot be turned off</span>
              </span>
              <button className="toggle" type="button" role="switch" aria-checked aria-disabled="true" aria-label="Withdrawals and payments, always on" disabled style={{ opacity: 0.7 }} />
            </div>
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>Signing a statement</strong>
              </span>
              <button className="toggle" type="button" role="switch" aria-checked={s.biometrics.signing} aria-label="Signing a statement" onClick={() => bio({ signing: !s.biometrics.signing })} />
            </div>
          </div>
        </>
      )}

      <p className="section-label">Devices</p>
      <div className="list">
        <button className="row" type="button" onClick={() => setSheet('devices')}>
          <span className="grow">
            <strong>Trusted devices</strong>
            <span className="sub">{s ? `${s.trustedDevices} ${s.trustedDevices === 1 ? 'device' : 'devices'}` : ''}</span>
          </span>
          <strong style={{ color: 'var(--color-signal-text)' }}>Manage</strong>
        </button>
        <button className="row" type="button" onClick={() => setSheet('sessions')}>
          <span className="grow">
            <strong>Active sessions</strong>
            <span className="sub">{s ? `This phone${s.sessions.others ? `, ${s.sessions.others} ${s.sessions.others === 1 ? 'other' : 'others'}` : ' only'}` : ''}</span>
          </span>
          <strong style={{ color: 'var(--color-signal-text)' }}>Manage</strong>
        </button>
        <button className="row" type="button" onClick={() => (s?.twoStep.on ? setSheet('codes') : setToast('Turn on two-step login first.'))}>
          <span className="grow">
            <strong>Recovery codes</strong>
            <span className="sub">{s?.recoveryCodes.generated ? `Use if you lose your phone. ${s.recoveryCodes.left} left` : 'Use if you lose your phone'}</span>
          </span>
          <strong style={{ color: 'var(--color-signal-text)' }}>View</strong>
        </button>
      </div>
      <p className="muted center" style={{ fontSize: 'var(--text-sm)' }}>
        Same settings for citizens, officers, agencies and admins.
      </p>

      {(sheet === '2fa' || sheet === '2fa-off' || sheet === 'codes') && (
        <CodeSheet
          mode={sheet}
          onClose={() => setSheet(null)}
          onDone={(m, shown) => done(m, shown)}
        />
      )}
      {sheet === 'pin' && s && <PinSheet hasPin={s.pin.set} onClose={() => setSheet(null)} onDone={(m) => done(m)} onForgot={() => setSheet('reset')} />}
      {sheet === 'reset' && (
        <Sheet open title="Reset your PIN" onClose={() => setSheet(null)} footer={null}>
          <ResetPin onDone={(m) => done(m)} onCancel={() => setSheet(null)} />
        </Sheet>
      )}
      {sheet === 'sessions' && <SessionsSheet onClose={() => setSheet(null)} onChanged={(m) => (setToast(m), void load())} />}
      {sheet === 'devices' && <DevicesSheet onClose={() => setSheet(null)} onChanged={(m) => (setToast(m), void load())} />}
      <Sheet
        open={!!codes}
        title="Your recovery codes"
        description="Each works once if you lose your phone. Write them down or save them somewhere safe. We show them only now."
        onClose={() => setCodes(null)}
        footer={
          <button className="btn primary" type="button" onClick={() => setCodes(null)}>
            I saved them
          </button>
        }
      >
        <div className="code-grid">{codes?.map((c) => <span key={c}>{c}</span>)}</div>
      </Sheet>
      <Toast msg={toast} />
    </main>
  );
}

function CodeSheet({ mode, onClose, onDone }: { mode: '2fa' | '2fa-off' | 'codes'; onClose: () => void; onDone: (m: string, codes?: string[]) => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const title = mode === '2fa' ? 'Turn on two-step login' : mode === '2fa-off' ? 'Turn off two-step login' : 'New recovery codes';
  const send = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api('/me/security/code', { method: 'POST' });
      setSent(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send a code. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!/^\d{6}$/.test(code)) return setErr('Enter the 6-digit code.');
    setBusy(true);
    setErr(null);
    try {
      const path = mode === '2fa' ? '/me/security/2fa' : mode === '2fa-off' ? '/me/security/2fa/off' : '/me/security/recovery-codes';
      const r = await api<{ message: string; recoveryCodes?: string[] }>(path, { method: 'POST', body: JSON.stringify({ code }) });
      onDone(r.message, r.recoveryCodes);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not check the code. Try again.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title={title}
      description={
        mode === '2fa'
          ? 'We text a code to your phone. After that, signing in on a new phone needs a code too.'
          : mode === '2fa-off'
            ? 'You will need it again to withdraw money.'
            : 'Old codes stop working. We text a code to your phone first.'
      }
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {sent ? (
            <button className="btn primary" type="button" onClick={confirm} disabled={busy}>
              {busy ? 'Checking…' : mode === '2fa-off' ? 'Turn off' : 'Confirm'}
            </button>
          ) : (
            <button className="btn primary" type="button" onClick={send} disabled={busy}>
              {busy ? 'Sending…' : 'Text me a code'}
            </button>
          )}
        </>
      }
    >
      {sent && (
        <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
          <span>6-digit code</span>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-invalid={!!err} />
        </label>
      )}
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}

/** Set or change the 4-digit PIN: current (if any), new, then the new one again. */
function PinSheet({ hasPin, onClose, onDone, onForgot }: { hasPin: boolean; onClose: () => void; onDone: (m: string) => void; onForgot: () => void }) {
  const [step, setStep] = useState<'current' | 'new' | 'again'>(hasPin ? 'current' : 'new');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enter = async (pin: string) => {
    setErr(null);
    if (step === 'current') {
      setCurrent(pin);
      return setStep('new');
    }
    if (step === 'new') {
      setNext(pin);
      return setStep('again');
    }
    if (pin !== next) {
      setStep('new');
      return setErr('The PINs did not match. Enter a new PIN again.');
    }
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/me/pin', { method: 'PUT', body: JSON.stringify(hasPin ? { pin, currentPin: current } : { pin }) });
      onDone(r.message);
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Could not save. Try again.';
      setStep(e instanceof ApiError && (e.code === 'pin_wrong' || e.code === 'pin_locked') ? 'current' : 'new');
      setErr(m);
      setBusy(false);
    }
  };
  return (
    <Sheet open title={hasPin ? 'Change your PIN' : 'Set a PIN'} onClose={onClose} busy={busy} footer={null}>
      <PinPad
        key={step}
        title={step === 'current' ? 'Your current PIN' : step === 'new' ? 'A new 4-digit PIN' : 'The new PIN again'}
        sub={step === 'new' ? 'Avoid 1234 or the same digit four times.' : undefined}
        error={err}
        busy={busy}
        onDone={enter}
        onForgot={hasPin && step === 'current' ? onForgot : undefined}
      />
    </Sheet>
  );
}

function SessionsSheet({ onClose, onChanged }: { onClose: () => void; onChanged: (m: string) => void }) {
  const [list, setList] = useState<Session[] | null>(null);
  const load = () => api<Session[]>('/auth/sessions').then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Sheet open title="Active sessions" description="Sign out any phone or browser you do not recognise." onClose={onClose} footer={<button className="btn" type="button" onClick={onClose}>Done</button>}>
      {list === null && <div className="skeleton" />}
      <div className="list" style={{ marginBottom: 0 }}>
        {list?.map((x) => (
          <div key={x.id} className="row" style={{ cursor: 'default' }}>
            <span className="grow">
              <strong>{x.label}</strong>
              <span className="sub">{x.current ? 'This phone' : `Last used ${when(x.lastSeen)}`}</span>
            </span>
            {!x.current && (
              <button
                className="link-btn"
                type="button"
                onClick={async () => {
                  await api(`/auth/sessions/${x.id}`, { method: 'DELETE' }).catch(() => {});
                  onChanged('Signed out.');
                  void load();
                }}
              >
                Sign out
              </button>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

function DevicesSheet({ onClose, onChanged }: { onClose: () => void; onChanged: (m: string) => void }) {
  const [list, setList] = useState<Device[] | null>(null);
  const load = () => api<Device[]>('/me/security/devices').then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Sheet open title="Trusted devices" description="These phones skip the SMS code when you sign in. Remove one to ask for a code again." onClose={onClose} footer={<button className="btn" type="button" onClick={onClose}>Done</button>}>
      {list === null && <div className="skeleton" />}
      {list?.length === 0 && <p className="muted">No trusted devices yet.</p>}
      {!!list?.length && (
        <div className="list" style={{ marginBottom: 0 }}>
          {list.map((d) => (
            <div key={d.id} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{d.label}</strong>
                <span className="sub">
                  {d.platform}, {when(d.lastSeen)}
                </span>
              </span>
              <button
                className="link-btn"
                type="button"
                onClick={async () => {
                  await api(`/me/security/devices/${d.id}`, { method: 'DELETE' }).catch(() => {});
                  onChanged(`${d.label} removed.`);
                  void load();
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
