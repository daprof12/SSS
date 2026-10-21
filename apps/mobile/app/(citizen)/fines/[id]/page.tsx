'use client';

import { formatNaira } from '@erp/domain';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { MethodPicker, usePay, type PayMethod } from '@/components/Pay';
import { Attachments, AttachPicker, uploadPicked, usePicked } from '@/components/reports/Attach';
import { api, ApiError } from '@/lib/client';

interface Fine {
  id: string;
  number: string;
  state: string;
  dueKobo: number;
  amountKobo: number;
  report: { id: string; label: string } | null;
  reason: string;
  trustDelta: number;
  canAppeal: boolean;
  canPay: boolean;
  appeal: { reason: string; note: string | null; at: string } | null;
  decision: { reason: string; at: string } | null;
  banner: { tone: string; title: string; line: string };
}
const MIN = 20;

/** Board "Fine and appeal": what happened, appeal (≥ 20 characters, evidence optional) or pay instead. */
export default function FinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [f, setF] = useState<Fine | null | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState<PayMethod>('wallet');
  const [toast, setToast] = useToast();
  const picked = usePicked();
  const [showAttach, setShowAttach] = useState(false);

  const load = () => api<Fine>(`/me/fines/${id}`).then(setF).catch(() => setF(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const { pay, busy: payBusy, ui } = usePay(
    (m, key, pin) => api(`/me/fines/${id}/pay`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ method: m, pin }) }),
    (r) => {
      setPaying(false);
      setToast(r.message ?? 'Paid.');
      void load();
    },
  );

  const appeal = async () => {
    if (reason.trim().length < MIN) {
      setErr(`Tell us why in at least ${MIN} characters.`);
      return document.querySelector<HTMLElement>('#appeal-reason')?.focus();
    }
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/me/fines/${id}/appeal`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      if (picked.items.length) await uploadPicked('fine', id, picked);
      setToast(r.message);
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (f === null) {
    return (
      <main className="app">
        <Header title="Fine" back="/fines" />
        <div className="empty">
          <strong>Fine not found.</strong>
          <Link href="/fines">Back to fines</Link>
        </div>
      </main>
    );
  }
  if (!f) return <main className="app">{<div className="skeleton" style={{ height: 240 }} />}</main>;

  return (
    <main className="app" style={{ paddingBottom: 180 }}>
      <Header title={`Fine ${f.number}`} back="/fines" />
      <div className={`banner ${f.banner.tone}`} role="status">
        <strong>{f.banner.title}</strong>
        {f.banner.line}
      </div>
      <div className="facts-list">
        <div>
          <span className="muted">Report</span>
          <strong style={{ textAlign: 'right' }}>{f.report ? <Link href={`/reports/${f.report.id}`}>{f.report.label}</Link> : '—'}</strong>
        </div>
        <div>
          <span className="muted">Reason</span>
          <strong style={{ textAlign: 'right' }}>{f.reason}</strong>
        </div>
        <div>
          <span className="muted">Trust score effect</span>
          <strong className={f.state === 'waived' ? 'ok' : 'bad'}>{f.state === 'waived' ? 'Restored' : f.trustDelta}</strong>
        </div>
        {f.dueKobo !== f.amountKobo && (
          <div>
            <span className="muted">Now due</span>
            <strong>
              {formatNaira(f.dueKobo)} <s className="muted">{formatNaira(f.amountKobo)}</s>
            </strong>
          </div>
        )}
      </div>

      {f.appeal && (
        <div className="card">
          <span className="muted">Your appeal</span>
          <p style={{ margin: '4px 0 0' }}>{f.appeal.reason}</p>
          {f.decision && (
            <>
              <span className="muted" style={{ display: 'block', marginTop: 12 }}>
                Decision
              </span>
              <p style={{ margin: '4px 0 0' }}>{f.decision.reason}</p>
            </>
          )}
        </div>
      )}
      {f.appeal && <Attachments ownerType="fine" ownerId={f.id} title="Your evidence" />}

      {f.canAppeal && (
        <>
          <label className="field" data-invalid={!!err}>
            <span>Why do you think this is wrong?</span>
            <textarea id="appeal-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} aria-invalid={!!err} aria-describedby="appeal-help" placeholder="What happened, who saw it, anything that shows it was real." />
            <small id="appeal-help" className="muted">
              {reason.trim().length < MIN ? `${MIN - reason.trim().length} more characters` : 'Thank you. Add a photo if you have one.'}
            </small>
          </label>
          {err && (
            <span className="field-error" role="alert">
              {err}
            </span>
          )}
          {showAttach ? (
            <AttachPicker picked={picked} disabled={busy} />
          ) : (
            <button className="attach-add" type="button" onClick={() => setShowAttach(true)} style={{ width: '100%', margin: '12px 0' }}>
              Add a photo or note, optional
            </button>
          )}
        </>
      )}

      {(f.canAppeal || f.canPay) && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', display: 'grid', gap: 8, maxWidth: 520, margin: '0 auto' }}>
          {f.canAppeal && (
            <button className="btn block primary" type="button" onClick={appeal} disabled={busy} style={{ minHeight: 56 }}>
              {busy ? 'Sending…' : 'Send appeal'}
            </button>
          )}
          {f.canPay && (
            <button className="btn block" type="button" onClick={() => setPaying(true)} disabled={busy} style={{ minHeight: 56 }}>
              Pay {formatNaira(f.dueKobo)}
              {f.canAppeal ? ' instead' : ''}
            </button>
          )}
        </div>
      )}

      <Sheet
        open={paying}
        title={`Pay ${formatNaira(f.dueKobo)}`}
        description={f.canAppeal ? 'Paying closes the fine. You cannot appeal it after.' : undefined}
        onClose={() => setPaying(false)}
        busy={payBusy}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setPaying(false)} disabled={payBusy}>
              Cancel
            </button>
            <button className="btn primary" type="button" onClick={() => {
                setPaying(false);
                void pay(method);
              }}
              disabled={payBusy}
            >
              {payBusy ? 'Starting…' : `Pay ${formatNaira(f.dueKobo)}`}
            </button>
          </>
        }
      >
        <MethodPicker value={method} onChange={setMethod} />
      </Sheet>
      {ui}
      <Toast msg={toast} />
      {f.state === 'paid' && (
        <button className="btn block" type="button" onClick={() => router.push('/payments')}>
          See receipt
        </button>
      )}
    </main>
  );
}
