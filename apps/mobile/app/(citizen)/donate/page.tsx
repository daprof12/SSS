'use client';

import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { formatNaira } from '@erp/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { MethodPicker, usePay, type PayMethod } from '@/components/Pay';
import { api } from '@/lib/client';

interface Target {
  id: string;
  name: string;
  sub: string;
  rating: number | null;
}
interface Targets {
  presetsKobo: number[];
  platformFeePct: number;
  minKobo: number;
  maxKobo: number;
  agencies: Target[];
  stations: Target[];
  officers: Target[];
}
type Tab = 'agency' | 'station' | 'officer';
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');

/** Board "Donate" (Support responders): agency, station or officer; wallet or Paystack; a receipt. */
export default function Donate() {
  const router = useRouter();
  const [t, setT] = useState<Targets | null>(null);
  const [tab, setTab] = useState<Tab>('agency');
  const [pick, setPick] = useState<Record<Tab, string | null>>({ agency: null, station: null, officer: null });
  const [amount, setAmount] = useState<number | 'other'>(100000);
  const [other, setOther] = useState('');
  const [method, setMethod] = useState<PayMethod>('card');
  const [showName, setShowName] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Targets>('/me/donate/targets')
      .then((x) => {
        setT(x);
        setPick({ agency: x.agencies[0]?.id ?? null, station: x.stations[0]?.id ?? null, officer: x.officers[0]?.id ?? null });
        // Someone who helped you first, when there is one (board order: agency, station, officer tabs).
        if (x.officers.length) setTab('officer');
      })
      .catch(() => {});
  }, []);

  const list = t ? { agency: t.agencies, station: t.stations, officer: t.officers }[tab] : [];
  const chosen = list.find((x) => x.id === pick[tab]);
  const kobo = amount === 'other' ? Math.round(Number(other.replace(/[^\d.]/g, '')) * 100) || 0 : amount;

  const { pay, busy, ui } = usePay(
    (m, key, pin) =>
      api('/me/donations', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ targetType: tab, targetId: chosen!.id, amountKobo: kobo, method: m, showName, pin }),
      }),
    (r) => router.push(`/payments/${encodeURIComponent(r.reference)}?thanks=1`),
  );

  const go = () => {
    setErr(null);
    if (!chosen) return setErr('Choose who to support.');
    if (!t || kobo < t.minKobo) return setErr(`Give at least ${naira(t?.minKobo ?? 10000)}.`);
    if (kobo > t.maxKobo) return setErr(`Give up to ${naira(t.maxKobo)} at a time.`);
    void pay(method);
  };

  return (
    <main className="app">
      <Header title="Support responders" back="/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        Your donation goes to the agency, station or officer you choose, and is shown on their profile.
      </p>
      <div className="tabs" role="tablist">
        {(['agency', 'station', 'officer'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === 'agency' ? 'Agency' : k === 'station' ? 'Station' : 'Officer'}
          </button>
        ))}
      </div>

      {!t && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
      {t && !list.length && (
        <div className="empty">
          <strong>{tab === 'officer' ? 'No officers yet.' : 'Nothing to show yet.'}</strong>
          {tab === 'officer' ? 'Officers who respond to your reports appear here, so you can thank them.' : 'Set your home in Profile to see stations near you.'}
        </div>
      )}
      <div role="radiogroup" aria-label="Who to support">
        {list.map((x) => (
          <button key={x.id} className="choice" type="button" role="radio" aria-checked={pick[tab] === x.id} aria-pressed={pick[tab] === x.id} onClick={() => setPick((p) => ({ ...p, [tab]: x.id }))}>
            <span className="thumb-sq" aria-hidden>
              <Icon name={tab === 'officer' ? 'user' : tab === 'station' ? 'home' : 'shield'} />
            </span>
            <span className="grow">
              <strong>{x.name}</strong>
              <span className="sub">{x.sub}</span>
            </span>
            {x.rating != null && <Rating value={x.rating} />}
          </button>
        ))}
      </div>

      <p className="section-label" style={{ marginTop: 16 }}>
        Amount
      </p>
      <div className="amounts" role="group" aria-label="Amount">
        {(t?.presetsKobo ?? [50000, 100000, 200000]).map((k) => (
          <button key={k} type="button" aria-pressed={amount === k} onClick={() => setAmount(k)}>
            {naira(k)}
          </button>
        ))}
        <button type="button" aria-pressed={amount === 'other'} onClick={() => setAmount('other')}>
          Other
        </button>
      </div>
      {!!kobo && t && (
        <p className="muted" style={{ margin: '-4px 0 12px', fontSize: 'var(--text-sm)' }}>
          {naira(kobo - Math.floor((kobo * t.platformFeePct) / 100))} reaches them. {t.platformFeePct}% keeps the platform running.
        </p>
      )}
      {amount === 'other' && (
        <label className="field">
          <span>Amount in naira</span>
          <input className="amount-input" inputMode="decimal" autoFocus value={other} onChange={(e) => setOther(e.target.value)} placeholder="₦" />
        </label>
      )}

      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Show my name to them</strong>
            <span className="sub">Off: they see "A citizen"</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={showName} aria-label="Show my name to them" onClick={() => setShowName((v) => !v)} />
        </div>
      </div>

      <p className="section-label">Pay with</p>
      <MethodPicker value={method} onChange={setMethod} />
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      {ui}
      <button className="btn block primary" type="button" onClick={go} disabled={busy || !t} style={{ minHeight: 60, fontSize: 'var(--text-lg)' }}>
        {busy ? 'Starting…' : method === 'wallet' ? `Donate ${kobo ? naira(kobo) : ''} from wallet` : `Donate ${kobo ? naira(kobo) : ''} with Paystack`}
      </button>
      <p className="muted center" style={{ fontSize: 'var(--text-sm)' }}>
        You get a receipt. Donations never change how fast help arrives.
      </p>
    </main>
  );
}
