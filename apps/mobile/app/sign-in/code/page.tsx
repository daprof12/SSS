'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { api, ApiError, haptic, setSession } from '@/lib/client';

interface Verified {
  accessToken: string;
  refreshToken: string;
  surface: 'citizen' | 'officer';
  isNew: boolean;
  needsName: boolean;
  secondFactorRequired: boolean;
}

const LEN = 6;

/** Code check (boards "Code check", "Code check wrong code"): 6 boxes, autofill, resend timer. */
function Code() {
  const router = useRouter();
  const params = useSearchParams();
  const phone = params.get('phone') ?? '';
  const masked = params.get('masked') ?? phone;
  const [digits, setDigits] = useState<string[]>(Array(LEN).fill(''));
  const [err, setErr] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(60);
  const [staffHold, setStaffHold] = useState(false);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    boxes.current[0]?.focus();
    const t = setInterval(() => setResendIn((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const submit = async (code: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<Verified>('/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ phone, code, device: { label: navigator.userAgent.includes('Mobile') ? 'Phone browser' : 'Web browser', platform: 'pwa' } }),
      });
      if (r.secondFactorRequired) {
        // Officers need two-step login (Public Issues doc §5); that screen is next.
        setStaffHold(true);
        setBusy(false);
        return;
      }
      setSession({ token: r.accessToken, refreshToken: r.refreshToken, name: '', roleLabel: r.surface === 'officer' ? 'Officer' : 'Citizen', surface: r.surface });
      haptic(30);
      const me = await api<{ name: string; onboarding: { done: boolean } }>('/me');
      setSession({ token: r.accessToken, refreshToken: r.refreshToken, name: me.name, roleLabel: 'Citizen', surface: r.surface });
      router.replace(r.surface === 'officer' ? '/officer' : me.onboarding.done ? '/home' : '/welcome');
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Something went wrong. Try again.');
      setShake((n) => n + 1);
      haptic([30, 40, 30]);
      setDigits(Array(LEN).fill(''));
      setBusy(false);
      // After re-enabling the boxes, or focus has nowhere to go.
      requestAnimationFrame(() => boxes.current[0]?.focus());
    }
  };

  const setAt = (i: number, v: string) => {
    const clean = v.replace(/\D/g, '');
    if (clean.length > 1) {
      // Pasted or SMS-autofilled: spread across the boxes.
      const all = clean.slice(0, LEN).split('');
      const next = Array(LEN).fill('').map((_, k) => all[k] ?? '');
      setDigits(next);
      if (all.length === LEN) void submit(all.join(''));
      else boxes.current[all.length]?.focus();
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    if (clean && i < LEN - 1) boxes.current[i + 1]?.focus();
    if (next.every(Boolean)) void submit(next.join(''));
  };

  const resend = async () => {
    setErr(null);
    try {
      await api('/auth/otp/start', { method: 'POST', body: JSON.stringify({ phone }) });
      setResendIn(60);
      setDigits(Array(LEN).fill(''));
      boxes.current[0]?.focus();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not send a new code.');
      const wait = x instanceof ApiError ? Number(x.extra.retryInSeconds ?? 0) : 0;
      if (wait) setResendIn(wait);
    }
  };

  if (staffHold) {
    return (
      <main className="app bare">
        <Header title="Two-step login" back="/sign-in" />
        <div className="banner warning">
          <strong>Officers need a second step</strong>
          Two-step login with an authenticator app comes next. Until then, use the demo officer accounts in development.
        </div>
      </main>
    );
  }

  return (
    <main className="app bare">
      <Header title="Enter the code" back="/sign-in" />
      <p className="muted" style={{ marginTop: -8 }}>
        We sent a 6-digit code to {masked}. It expires in 5 minutes.
      </p>
      <div key={shake} className={shake ? 'otp shake' : 'otp'} role="group" aria-label="6-digit code">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              boxes.current[i] = el;
            }}
            className="otp-box"
            value={d}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={i === 0 ? LEN : 1}
            aria-label={`Digit ${i + 1}`}
            aria-invalid={!!err}
            disabled={busy}
            onChange={(e) => setAt(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
            }}
          />
        ))}
      </div>
      {err && (
        <p className="field-error" role="alert">
          {err}
        </p>
      )}
      {busy && <p className="muted">Checking…</p>}
      <button className="btn block" type="button" disabled={resendIn > 0} onClick={resend} style={{ marginTop: 16 }}>
        {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
      </button>
      <p className="muted center">Wrong number? Go back and change it.</p>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Code />
    </Suspense>
  );
}
