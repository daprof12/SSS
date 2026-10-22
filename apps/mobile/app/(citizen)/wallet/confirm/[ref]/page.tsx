'use client';

import { LinkButton } from '@erp/web-ui/LinkButton';
import { formatNaira } from '@erp/domain';
import { use, useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, haptic } from '@/lib/client';

interface Status {
  reference: string;
  state: 'initiated' | 'pending' | 'succeeded' | 'failed' | 'abandoned';
  amountKobo: number;
  message: string;
}

const STILL_PENDING_MS = 30000;

/** Step 4–5: wait for the signed webhook; never trust the browser callback. */
export default function Confirm({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const [s, setS] = useState<Status | null>(null);
  const [slow, setSlow] = useState(false);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const started = Date.now();
    let stop = false;
    const poll = async () => {
      const x = await api<Status>(`/me/payments/${encodeURIComponent(ref)}`).catch(() => null);
      if (stop) return;
      if (x) setS(x);
      if (x && (x.state === 'succeeded' || x.state === 'failed')) return;
      if (Date.now() - started > STILL_PENDING_MS) return setSlow(true);
      setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [ref]);

  // Balance count-up (motion spec: 600 ms).
  useEffect(() => {
    if (s?.state !== 'succeeded') return;
    haptic([40, 30, 40]);
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600);
      setShown(Math.round(s.amountKobo * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [s?.state, s?.amountKobo]);

  if (s?.state === 'succeeded') {
    return (
      <main className="app bare center">
        <div className="check">
          <Icon name="check" size={44} />
        </div>
        <div className="big-number">+{formatNaira(shown)}</div>
        <p className="muted">{s.message}</p>
        <p className="muted" style={{ fontSize: 12 }}>Reference {s.reference}</p>
        <LinkButton href="/wallet" className="btn block signal">
          Back to wallet
        </LinkButton>
      </main>
    );
  }
  if (s?.state === 'failed' || s?.state === 'abandoned') {
    return (
      <main className="app bare">
        <Header title={s.state === 'failed' ? 'Payment did not go through' : 'Payment not finished'} back="/wallet" />
        <div className="banner critical" role="alert">
          {s.message}
        </div>
        <LinkButton href="/wallet/fund" className="btn block signal">
          Try again
        </LinkButton>
      </main>
    );
  }
  return (
    <main className="app bare center">
      <div className="ring" aria-hidden style={{ width: 96, height: 96 }}>
        <svg viewBox="0 0 100 100" width="96" height="96" style={{ animation: 'spin 1s linear infinite' }}>
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--color-divider)" strokeWidth="8" />
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--color-signal)" strokeWidth="8" strokeDasharray="60 200" strokeLinecap="round" />
        </svg>
      </div>
      <h1 role="status">{slow ? 'Still confirming' : 'Confirming your payment'}</h1>
      <p className="muted">
        {slow ? 'This is taking longer than usual. We will tell you as soon as it lands. You can leave this screen.' : 'This usually takes a few seconds.'}
      </p>
      <p className="muted" style={{ fontSize: 12 }}>Reference {ref}</p>
      {slow && (
        <LinkButton href="/wallet" className="btn block">
          Back to wallet
        </LinkButton>
      )}
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}[data-motion="reduced"] svg{animation:none!important}'}</style>
    </main>
  );
}
