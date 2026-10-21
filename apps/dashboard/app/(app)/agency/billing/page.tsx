'use client';
// Board "Agency billing": what the agency pays the platform for onboarding and inventory. Agency
// admins and agency finance can see it and pay.
import { api, ApiError, downloadFile } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { AgencySwitcher, shortDate, useToast, WithAgency, type MyAgency } from '@/components/Agency';
import { naira } from '@/components/Dash';

interface Billing {
  stats: { onboardingKobo: number; onboardingPaidAt: string | null; inventoryMonthKobo: number; inventoryItems: number; balanceKobo: number; balanceDueOn: string | null; nextInvoiceOn: string | null };
  invoices: { id: string; number: string; kind: string; state: string; dueOn: string; totalKobo: number; balanceKobo: number; lines: { label: string; quantity?: number }[]; paidAt: string | null }[];
  fees: { code: string; label: string; amount: string; per: string }[];
  paymentMethod: { method: string; reference: string } | null;
  checklist: { documentsApproved: boolean; onboardingPaid: boolean; headVerified: boolean };
  openInvoiceId: string | null;
}
const STATE: Record<string, [string, string]> = {
  paid: ['Paid', 'var(--color-success-text)'],
  issued: ['Due', 'var(--color-warning-text)'],
  overdue: ['Overdue', 'var(--color-emergency-text)'],
  waived: ['Waived', 'var(--color-text-secondary)'],
  credited: ['Credited', 'var(--color-text-secondary)'],
  draft: ['Draft', 'var(--color-text-secondary)'],
};
const KIND: Record<string, string> = { onboarding: 'Agency onboarding fee', monthly: 'Monthly plan and inventory', change: 'Plan change', overage: 'Station over allowance' };

export default function AgencyBillingPage() {
  return <WithAgency>{(a) => <BillingBoard key={a.id} agency={a} />}</WithAgency>;
}

function BillingBoard({ agency }: { agency: MyAgency }) {
  const [b, setB] = useState<Billing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Billing>(`/agencies/${agency.id}/billing`)
      .then(setB)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load billing.'));
  }, [agency.id]);
  useEffect(load, [load]);
  const pay = async () => {
    if (!b?.openInvoiceId) return;
    setBusy(true);
    try {
      const r = await api<{ authorizationUrl?: string; message: string; reference: string }>(`/agencies/${agency.id}/invoices/${b.openInvoiceId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `pay-${b.openInvoiceId}-${Date.now()}` },
        body: JSON.stringify({ method: 'card' }),
      });
      if (r.authorizationUrl) window.open(r.authorizationUrl, '_blank', 'noopener');
      setToast(`${r.message} Reference ${r.reference}.`);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not start the payment.');
    } finally {
      setBusy(false);
    }
  };
  const s = b?.stats;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Billing</h1>
          <p className="lede">What you pay the platform for onboarding and inventory.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <AgencySwitcher />
          <button className="btn" type="button" disabled={!b?.invoices.length} onClick={() => downloadFile(`/agencies/${agency.id}/invoices.csv`, 'invoices.csv').catch((e) => setToast(e.message))}>
            Download invoices
          </button>
          <button className="btn signal" type="button" disabled={busy || !b?.openInvoiceId} onClick={pay}>
            {busy ? 'Starting…' : 'Pay balance'}
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Onboarding fee</span>
          <strong className="success">{s ? naira(s.onboardingKobo) : '—'}</strong>
          <small>{s?.onboardingPaidAt ? `Paid ${shortDate(s.onboardingPaidAt)}` : 'Not paid yet'}</small>
        </div>
        <div className="stat">
          <span>Inventory this month</span>
          <strong>{s ? naira(s.inventoryMonthKobo) : '—'}</strong>
          <small>{s ? `${s.inventoryItems} items` : ''}</small>
        </div>
        <div className="stat">
          <span>Balance due</span>
          <strong className="warning">{s ? naira(s.balanceKobo) : '—'}</strong>
          <small>{s?.balanceDueOn ? `Due ${shortDate(s.balanceDueOn)}` : 'Nothing due'}</small>
        </div>
        <div className="stat">
          <span>Next invoice</span>
          <strong className="info">{s?.nextInvoiceOn ? shortDate(s.nextInvoiceOn) : '—'}</strong>
          <small>Monthly</small>
        </div>
      </div>
      <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)' }}>
        <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="inv">
          <h2 id="inv" style={{ margin: 0, padding: '16px 16px 0' }}>
            Invoices
          </h2>
          {!b ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" />
            </div>
          ) : !b.invoices.length ? (
            <div className="empty">No invoices yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {b.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{shortDate(i.dueOn)}</strong>
                      <div className="muted">{i.number}</div>
                    </td>
                    <td>
                      {KIND[i.kind] ?? i.kind}
                      <div className="muted">{i.lines.map((l) => l.label).slice(0, 3).join(', ')}</div>
                    </td>
                    <td>
                      {naira(i.totalKobo)}
                      {i.balanceKobo > 0 && i.balanceKobo < i.totalKobo && <div className="muted">{naira(i.balanceKobo)} left</div>}
                    </td>
                    <td>
                      <strong style={{ color: STATE[i.state]?.[1] }}>{STATE[i.state]?.[0] ?? i.state}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="card" aria-labelledby="fees">
          <h2 id="fees" style={{ marginTop: 0 }}>
            Fee schedule
          </h2>
          {b?.fees.map((f) => (
            <div className="row" key={f.code}>
              <div className="label">
                <strong>{f.label}</strong>
                <span>{f.per}</span>
              </div>
              <strong>{f.amount}</strong>
            </div>
          ))}
          <p className="muted" style={{ marginBottom: 0 }}>
            Prices are set by the platform team. Removing an item from your inventory stops its fee from the next invoice.
          </p>
        </section>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="pm">
          <h2 id="pm" style={{ marginTop: 0 }}>
            Payment method
          </h2>
          <div className="banner neutral" style={{ margin: 0 }}>
            <small className="muted">Paid through Paystack</small>
            <div>{b?.paymentMethod ? `${b.paymentMethod.method === 'card' ? 'Card' : b.paymentMethod.method === 'bank_transfer' ? 'Bank transfer' : b.paymentMethod.method}, reference ending ${b.paymentMethod.reference}` : 'No payment yet. You choose card, transfer or USSD when you pay.'}</div>
          </div>
        </section>
        <section className="card" aria-labelledby="act">
          <h2 id="act" style={{ marginTop: 0 }}>
            Before you are active
          </h2>
          {(
            [
              ['Documents approved', b?.checklist.documentsApproved],
              ['Onboarding fee paid', b?.checklist.onboardingPaid],
              ['Head identity verified', b?.checklist.headVerified],
            ] as [string, boolean | undefined][]
          ).map(([k, v]) => (
            <div className="row" key={k}>
              <strong>{k}</strong>
              <strong style={{ color: v ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{v ? 'Done' : 'To do'}</strong>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
