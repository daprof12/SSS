'use client';
// Staff sign-in: the phone code, then two-step login with an authenticator app (set up once, with
// recovery codes). Development builds also list the demo accounts, which skip both steps.
import { ROLE_LABEL, type Role } from '@erp/domain';
import { api, ApiError, setSession } from '@erp/web-ui/api';
import { Qr } from '@erp/web-ui/Qr';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const DEMO = process.env.NODE_ENV !== 'production';
const DEMO_ACCOUNTS = [
  { key: 'head', name: 'CSP Ngozi Eze', roleLabel: 'Station head', home: '/incidents' },
  { key: 'dispatcher', name: 'Amaka Dispatch', roleLabel: 'Dispatcher', home: '/incidents' },
  { key: 'agencyAdmin', name: 'Agency Admin', roleLabel: 'Agency admin', home: '/agency/overview' },
  { key: 'naptipAdmin', name: 'NAPTIP Admin', roleLabel: 'Agency admin', home: '/agency/overview' },
  { key: 'fermaAdmin', name: 'FERMA Admin', roleLabel: 'Agency admin', home: '/agency/overview' },
  { key: 'agencyFinance', name: 'Kemi Finance', roleLabel: 'Agency finance', home: '/agency/billing' },
  { key: 'platformAdmin', name: 'Platform Admin', roleLabel: 'Platform admin', home: '/admin/overview' },
  { key: 'platformFinance', name: 'Femi Ledger', roleLabel: 'Platform finance', home: '/admin/overview' },
  { key: 'platformSupport', name: 'Ifeoma Support', roleLabel: 'Platform support', home: '/admin/support' },
  { key: 'platformOps', name: 'Sani Field Ops', roleLabel: 'Platform operations', home: '/admin/coverage' },
] as const;

/** The dashboard's staff roles, most senior first, with where each lands after sign-in. */
const STAFF: [Role, string][] = [
  ['platform_admin', '/admin/overview'],
  ['platform_finance', '/admin/overview'],
  ['platform_support', '/admin/support'],
  ['platform_ops', '/admin/coverage'],
  ['agency_admin', '/agency/overview'],
  ['agency_finance', '/agency/billing'],
  ['head', '/incidents'],
  ['dispatcher', '/incidents'],
];

type Step = 'phone' | 'code' | 'setup' | 'recovery' | 'second';
interface Verified {
  accessToken: string;
  refreshToken: string;
  secondFactorRequired: boolean;
}

export default function SignIn() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [refresh, setRefresh] = useState('');
  const [setup, setSetup] = useState<{ key: string; otpauthUrl: string } | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const token = useRef('');

  // Opening sign-in ends any earlier session in this tab, so an old token never mixes with the new one.
  useEffect(() => setSession(null), []);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
      if (e instanceof ApiError && (e.code === 'mfa_locked' || e.code === 'session_ended')) restart();
    } finally {
      setBusy(false);
    }
  };
  // Calls made between the phone code and the second step carry the half-signed-in token.
  const authed = <T,>(path: string, body?: unknown) =>
    api<T>(path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${token.current}` } });

  const restart = () => {
    token.current = '';
    setStep('phone');
    setCode('');
    setSetup(null);
    setUseRecovery(false);
  };

  const sendCode = () =>
    run(async () => {
      const r = await api<{ phone: string; resendInSeconds: number }>('/auth/otp/start', { method: 'POST', body: JSON.stringify({ phone }) });
      setMasked(r.phone);
      setResendIn(r.resendInSeconds);
      setCode('');
      setStep('code');
      if (DEMO) {
        // Development only: the mock SMS outbox, so the code can be read without a phone.
        const out = await api<{ to: string; body: string }[]>('/dev/sms').catch(() => []);
        setDevCode(/code is (\d{6})/.exec([...out].reverse().find((m) => m.body.includes('ERP code'))?.body ?? '')?.[1] ?? null);
      }
    });

  const verifyCode = () =>
    run(async () => {
      const r = await api<Verified>('/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone, code, device: { label: 'Dashboard', platform: 'web' } }) });
      token.current = r.accessToken;
      setRefresh(r.refreshToken);
      setCode('');
      const s = await authed<{ required: boolean; enrolled: boolean }>('/auth/mfa');
      if (!s.required) return finish(r.accessToken, r.refreshToken);
      if (s.enrolled) return setStep('second');
      setSetup(await authed<{ key: string; otpauthUrl: string }>('/auth/mfa/setup', {}));
      setStep('setup');
    });

  const confirmSetup = () =>
    run(async () => {
      const r = await authed<{ accessToken: string; recoveryCodes: string[] }>('/auth/mfa/confirm', { code });
      token.current = r.accessToken;
      setRecovery(r.recoveryCodes);
      setStep('recovery');
    });

  const verifySecond = () =>
    run(async () => {
      const r = await authed<{ accessToken: string; recoveryCodesLeft: number }>('/auth/mfa/verify', useRecovery ? { recoveryCode: code } : { code });
      await finish(r.accessToken, refresh);
    });

  /** Signed in: only staff may use the dashboard; send each to their home page. */
  const finish = async (accessToken: string, refreshToken: string) => {
    token.current = accessToken;
    const me = await authed<{ name: string; roles: { role: Role }[] }>('/me');
    const top = STAFF.find(([r]) => me.roles.some((g) => g.role === r));
    if (!top) {
      await authed('/auth/sign-out', {}).catch(() => {});
      restart();
      throw new ApiError(403, 'not_staff', 'This dashboard is for station, agency and platform staff. Citizens and officers use the ERP app.');
    }
    setSession({ token: accessToken, refreshToken, name: me.name, roleLabel: ROLE_LABEL[top[0]] });
    router.replace(top[1]);
  };

  const demoSignIn = (a: (typeof DEMO_ACCOUNTS)[number]) =>
    run(async () => {
      const seed = await api<{ users: Record<string, string> }>('/dev/seed', { method: 'POST' });
      const { token: t } = await api<{ token: string }>('/dev/token', { method: 'POST', body: JSON.stringify({ userId: seed.users[a.key] }) });
      setSession({ token: t, name: a.name, roleLabel: a.roleLabel });
      router.replace(a.home);
    });

  const codeField = (label: string, hint: string, onSubmit: () => void, recoveryMode = false) => (
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
          style={{ fontSize: 22, letterSpacing: recoveryMode ? 2 : 8, textAlign: 'center' }}
        />
        <small className="muted">{hint}</small>
      </label>
      <button className="btn primary" type="submit" disabled={busy || (recoveryMode ? code.trim().length < 8 : code.length !== 6)} style={{ width: '100%' }}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
    </form>
  );

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 440 }}>
        <div className="brand-mark" aria-hidden style={{ marginBottom: 16 }}>
          ERP
        </div>
        <h1>{step === 'setup' ? 'Set up two-step login' : step === 'recovery' ? 'Save your recovery codes' : step === 'second' ? 'Two-step login' : 'Sign in'}</h1>
        {error && (
          <div className="banner critical" role="alert">
            {error}
          </div>
        )}

        {step === 'phone' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            <p className="lede">For station, agency and platform staff. We send a code to your phone, then ask for the code from your authenticator app.</p>
            <label className="field">
              <span>Phone number</span>
              <input type="tel" autoComplete="tel" autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0803 123 4567" />
            </label>
            <button className="btn primary" type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10} style={{ width: '100%' }}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <>
            <p className="lede">We sent a 6-digit code to {masked}. It expires in 5 minutes.</p>
            {devCode && <div className="banner info">Development: the code is {devCode}.</div>}
            {codeField('Code from the text message', 'Never share this code, not even with us.', () => void verifyCode())}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button className="btn" type="button" onClick={restart} disabled={busy}>
                Change number
              </button>
              <button className="btn" type="button" onClick={() => void sendCode()} disabled={busy || resendIn > 0}>
                {resendIn > 0 ? `Send again in ${resendIn}s` : 'Send again'}
              </button>
            </div>
          </>
        )}

        {step === 'setup' && setup && (
          <>
            <p className="lede">Staff accounts need a second step. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator or similar), then enter the code it shows.</p>
            <div style={{ display: 'grid', justifyItems: 'center', gap: 8, margin: '8px 0 16px' }}>
              <Qr text={setup.otpauthUrl} label="QR code to add ERP to your authenticator app" />
              <small className="muted">Cannot scan? Enter this key in the app:</small>
              <code style={{ fontSize: 15, letterSpacing: 1, userSelect: 'all', textAlign: 'center' }}>{setup.key}</code>
            </div>
            {codeField('Code from your app', 'The code changes every 30 seconds.', () => void confirmSetup())}
          </>
        )}

        {step === 'recovery' && recovery && (
          <>
            <p className="lede">If you lose the phone with your app, each of these codes lets you in once. Keep them somewhere safe. They are shown only now.</p>
            <ol style={{ columns: 2, fontFamily: 'ui-monospace, monospace', fontSize: 16, padding: '0 0 0 24px', margin: '8px 0 16px' }}>
              {recovery.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" type="button" onClick={() => void navigator.clipboard?.writeText(recovery.join('\n'))}>
                Copy
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(new Blob([`ERP recovery codes\n\n${recovery.join('\n')}\n`], { type: 'text/plain' }));
                  a.download = 'erp-recovery-codes.txt';
                  a.click();
                  URL.revokeObjectURL(a.href);
                }}
              >
                Download
              </button>
              <button className="btn primary" type="button" disabled={busy} onClick={() => void run(() => finish(token.current, refresh))} style={{ marginLeft: 'auto' }}>
                I saved them
              </button>
            </div>
          </>
        )}

        {step === 'second' && (
          <>
            <p className="lede">{useRecovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the code from your authenticator app.'}</p>
            {codeField(useRecovery ? 'Recovery code' : 'Code from your app', useRecovery ? 'After five wrong tries you start again from the phone code.' : 'The code changes every 30 seconds.', () => void verifySecond(), useRecovery)}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button className="btn" type="button" onClick={restart} disabled={busy}>
                Start again
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setUseRecovery((x) => !x);
                  setCode('');
                }}
                disabled={busy}
              >
                {useRecovery ? 'Use the app instead' : 'Lost your phone?'}
              </button>
            </div>
          </>
        )}

        {DEMO && step === 'phone' && (
          <details style={{ marginTop: 20 }}>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              Development accounts (skip both steps)
            </summary>
            <div className="grid" style={{ marginTop: 12 }}>
              {DEMO_ACCOUNTS.map((a) => (
                <button key={a.key} className="btn" type="button" disabled={busy} onClick={() => void demoSignIn(a)} style={{ justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}>
                  <span>{a.name}</span>
                  <span className="chip neutral">{a.roleLabel}</span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </main>
  );
}

