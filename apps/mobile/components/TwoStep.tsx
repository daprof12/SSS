'use client';
// Two-step login for officers and other staff on the phone: after the text-message code, set up an
// authenticator app once (open it from here, or copy the key; a QR code for another device), save
// the recovery codes, and from then on enter the app's code. "Lost your phone?" takes a recovery code.
import { Qr } from '@erp/web-ui/Qr';
import { useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { api, ApiError, haptic } from '@/lib/client';

type Step = 'loading' | 'setup' | 'recovery' | 'second';

export function TwoStep({ token, onDone, onRestart }: { token: string; onDone: (accessToken: string) => void; onRestart: (reason?: 'mfa_locked' | 'session_ended') => void }) {
  const [step, setStep] = useState<Step>('loading');
  const [setup, setSetup] = useState<{ key: string; otpauthUrl: string } | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const current = useRef(token);

  // Calls before the second step carry the half-signed-in token.
  const authed = <T,>(path: string, body?: unknown) =>
    api<T>(path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${current.current}` } });

  const fail = (x: unknown) => {
    if (x instanceof ApiError && (x.code === 'mfa_locked' || x.code === 'session_ended')) return onRestart(x.code);
    setErr(x instanceof ApiError ? x.message : 'Something went wrong. Try again.');
    haptic([30, 40, 30]);
  };

  useEffect(() => {
    (async () => {
      try {
        const s = await authed<{ enrolled: boolean }>('/auth/mfa');
        if (s.enrolled) return setStep('second');
        setSetup(await authed<{ key: string; otpauthUrl: string }>('/auth/mfa/setup', {}));
        setStep('setup');
      } catch (x) {
        fail(x);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      fail(x);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setErr('Could not copy. Select the text and copy it.');
    }
  };

  const codeForm = (label: string, onSubmit: () => void, recoveryMode = false) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="field">
        <span>{label}</span>
        <input
          type="text"
          inputMode={recoveryMode ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          autoFocus
          value={code}
          maxLength={recoveryMode ? 20 : 6}
          placeholder={recoveryMode ? 'xxxx-xxxx' : '6 digits'}
          onChange={(e) => setCode(recoveryMode ? e.target.value : e.target.value.replace(/\D/g, ''))}
          aria-invalid={!!err}
          style={{ fontSize: 24, letterSpacing: recoveryMode ? 2 : 8, textAlign: 'center' }}
        />
      </label>
      {err && (
        <p className="field-error" role="alert">
          {err}
        </p>
      )}
      <button className="btn block primary" type="submit" disabled={busy || (recoveryMode ? code.trim().length < 8 : code.length !== 6)}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );

  if (step === 'loading') {
    return (
      <main className="app bare">
        <Header title="Two-step login" back={false} />
        {err ? (
          <div className="banner critical" role="alert">
            {err}
          </div>
        ) : (
          <div className="skeleton" style={{ height: 200 }} />
        )}
      </main>
    );
  }

  if (step === 'setup' && setup) {
    return (
      <main className="app bare">
        <Header title="Set up two-step login" back={false} />
        <p className="muted" style={{ marginTop: -8 }}>
          Officers and staff need a second step. Add ERP to an authenticator app (Google Authenticator, Microsoft Authenticator or similar), then enter the code it shows.
        </p>
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <a className="btn block signal" href={setup.otpauthUrl}>
            Open my authenticator app
          </a>
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            If nothing opens, copy this key into the app:
          </span>
          <code style={{ fontSize: 16, letterSpacing: 1, userSelect: 'all', textAlign: 'center' }}>{setup.key}</code>
          <button className="btn block" type="button" onClick={() => void copy(setup.key.replace(/\s/g, ''), 'key')}>
            {copied === 'key' ? 'Copied' : 'Copy key'}
          </button>
          <details>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              App on another phone? Scan a QR code
            </summary>
            <div style={{ display: 'grid', justifyItems: 'center', marginTop: 10 }}>
              <Qr text={setup.otpauthUrl} size={180} label="QR code to add ERP to your authenticator app" />
            </div>
          </details>
        </div>
        {codeForm('Code from your app', () =>
          void run(async () => {
            const r = await authed<{ accessToken: string; recoveryCodes: string[] }>('/auth/mfa/confirm', { code });
            current.current = r.accessToken;
            setRecovery(r.recoveryCodes);
            setCode('');
            setStep('recovery');
            haptic(30);
          }),
        )}
      </main>
    );
  }

  if (step === 'recovery' && recovery) {
    return (
      <main className="app bare">
        <Header title="Save your recovery codes" back={false} />
        <p className="muted" style={{ marginTop: -8 }}>
          If you lose this phone, each code lets you in once. Keep them somewhere safe, not on this phone. They are shown only now.
        </p>
        <ol className="card" style={{ columns: 2, fontFamily: 'ui-monospace, monospace', fontSize: 16, paddingLeft: 36 }}>
          {recovery.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <button className="btn block" type="button" onClick={() => void copy(recovery.join('\n'), 'codes')} style={{ marginBottom: 8 }}>
          {copied === 'codes' ? 'Copied' : 'Copy codes'}
        </button>
        {err && (
          <p className="field-error" role="alert">
            {err}
          </p>
        )}
        <button className="btn block primary" type="button" onClick={() => onDone(current.current)}>
          I saved them
        </button>
      </main>
    );
  }

  return (
    <main className="app bare">
      <Header title="Two-step login" back={false} />
      <p className="muted" style={{ marginTop: -8 }}>
        {useRecovery ? 'Enter one of your recovery codes. Each works once.' : 'Open your authenticator app and enter the code for ERP Nigeria.'}
      </p>
      {codeForm(useRecovery ? 'Recovery code' : 'Code from your app', () =>
        void run(async () => {
          const r = await authed<{ accessToken: string }>('/auth/mfa/verify', useRecovery ? { recoveryCode: code } : { code });
          haptic(30);
          onDone(r.accessToken);
        }),
      useRecovery)}
      <button
        className="btn block"
        type="button"
        style={{ marginTop: 8 }}
        onClick={() => {
          setUseRecovery((x) => !x);
          setCode('');
          setErr(null);
        }}
      >
        {useRecovery ? 'Use the app instead' : 'Lost your phone?'}
      </button>
      <button className="btn block" type="button" style={{ marginTop: 8 }} onClick={() => onRestart()}>
        Start again
      </button>
      <p className="muted center">After five wrong codes you start again from the text message.</p>
    </main>
  );
}
