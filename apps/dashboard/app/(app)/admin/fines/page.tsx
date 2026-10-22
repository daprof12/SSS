'use client';
// Boards "Admin fines and appeals" and "Admin fine appeal" (B8 step 4): read the appeal, then
// waive, reduce or uphold with a reason the citizen reads. Waiving gives the trust points back.
import { formatNaira } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, useToast } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';
import { DateRange, useDateRange } from '@/components/DateRange';

interface Fine {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  amountKobo: number;
  dueKobo: number;
  report: { id: string; label: string } | null;
  reason: string;
  trustDelta: number;
  appealBy: string;
  appeal: { reason: string; note: string | null; at: string } | null;
  decision: { reason: string; at: string } | null;
  citizen: string;
  trust: number;
}
type Filter = 'appealed' | 'open' | 'all';
const FILTERS: [Filter, string][] = [
  ['appealed', 'Appealed'],
  ['open', 'Open'],
  ['all', 'All'],
];
const TONE: Record<string, string> = { open: 'warning', appealed: 'info', reduced: 'warning', upheld: 'critical', waived: 'success', paid: 'success' };
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');

export default function FinesAdmin() {
  const [filter, setFilter] = useState<Filter>('appealed');
  const [d, setD] = useState<{ counts: Record<string, number>; items: Fine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Fine | null>(null);
  const [toast, setToast] = useToast();
  const [loc, setLoc] = useState<LocFilter>({});
  const dates = useDateRange('all');
  const lq = [locQuery(loc), dates.q].filter(Boolean).join('&');
  const load = useCallback(() => {
    api<{ counts: Record<string, number>; items: Fine[] }>(`/admin/fines?status=${filter}${lq ? `&${lq}` : ''}`)
      .then(setD)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load fines.'));
  }, [filter, lq]);
  useEffect(() => {
    setD(null);
    load();
  }, [load]);

  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Fines and appeals</h1>
          <p className="lede">False alarms after a warning become fines. Citizens can appeal within 14 days; each decision needs a reason they will read.</p>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Waiting for a decision</span>
          <strong className="warning">{d ? (d.counts.appealed ?? 0) : '—'}</strong>
          <small>Appeals to review</small>
        </div>
        <div className="stat">
          <span>Open, not appealed</span>
          <strong>{d ? (d.counts.open ?? 0) : '—'}</strong>
          <small>Inside the appeal window</small>
        </div>
        <div className="stat">
          <span>Waived</span>
          <strong className="success">{d ? (d.counts.waived ?? 0) : '—'}</strong>
          <small>Trust restored</small>
        </div>
      </div>
      <div className="segmented tabs" role="tablist" aria-label="Filter fines">
        {FILTERS.map(([f, l]) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {l}
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!d && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : !d?.items.length ? (
          <div className="empty">
            <strong>{filter === 'appealed' ? 'No appeals waiting.' : 'No fines here.'}</strong>
            Fines start after a warning, when an officer closes a report as a false alarm.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Fine</th>
                <th>Citizen</th>
                <th>Report</th>
                <th>Amount</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((f) => (
                <tr key={f.id} className="link" onClick={() => setOpen(f)}>
                  <td>
                    <button type="button" className="link-btn" style={{ fontWeight: 700, color: 'inherit' }} onClick={(e) => (e.stopPropagation(), setOpen(f))}>
                      {f.number}
                    </button>
                    <div className="muted">{f.appeal ? `Appealed ${dateTime(f.appeal.at)}` : `Appeal by ${dateTime(f.appealBy)}`}</div>
                  </td>
                  <td>
                    {f.citizen}
                    <div className="muted">Trust {f.trust}</div>
                  </td>
                  <td>{f.report?.label ?? '—'}</td>
                  <td>{naira(f.dueKobo)}</td>
                  <td>
                    <span className={`chip ${TONE[f.state] ?? 'neutral'}`}>{f.stateLabel}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && (
        <Decide
          f={open}
          onClose={() => setOpen(null)}
          onDone={(m) => {
            setOpen(null);
            setToast(m);
            load();
          }}
        />
      )}
    </>
  );
}

function Decide({ f, onClose, onDone }: { f: Fine; onClose: () => void; onDone: (m: string) => void }) {
  const [decision, setDecision] = useState<'waive' | 'reduce' | 'uphold' | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const canDecide = f.state === 'appealed' || f.state === 'open';
  const options: ['waive' | 'reduce' | 'uphold', string][] = f.state === 'appealed' ? [['waive', 'Waive'], ['reduce', 'Reduce'], ['uphold', 'Uphold']] : [['waive', 'Waive']];
  const kobo = Math.round(Number(amount.replace(/[^\d.]/g, '')) * 100) || 0;
  const bad = { reason: reason.trim().length < 5, amount: decision === 'reduce' && (kobo <= 0 || kobo >= f.amountKobo) };
  const submit = () => {
    setTried(true);
    if (!decision || bad.reason || bad.amount) return focusFirstError();
    void s.run(async () => {
      const r = await api<{ message: string }>(`/admin/fines/${f.id}/decision`, { method: 'POST', body: JSON.stringify({ decision, reason: reason.trim(), amountKobo: decision === 'reduce' ? kobo : undefined }) });
      onDone(`${f.number}: ${r.message}`);
    });
  };
  return (
    <Sheet
      open
      title={`Fine ${f.number}`}
      description={`${f.citizen}, ${f.report?.label ?? ''}`}
      onClose={onClose}
      busy={s.busy}
      footer={
        canDecide ? (
          <>
            <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
              Cancel
            </button>
            <button className="btn primary" type="button" onClick={submit} disabled={s.busy}>
              {s.busy ? 'Saving…' : decision === 'waive' ? 'Waive fine' : decision === 'reduce' ? `Reduce to ${kobo ? naira(kobo) : '…'}` : decision === 'uphold' ? 'Uphold fine' : 'Decide'}
            </button>
          </>
        ) : (
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <ErrorBox error={s.error} />
      <dl className="facts">
        <div>
          <dt>Amount</dt>
          <dd>
            {naira(f.dueKobo)}
            {f.dueKobo !== f.amountKobo ? ` (was ${naira(f.amountKobo)})` : ''}
          </dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{f.reason}</dd>
        </div>
        <div>
          <dt>Trust effect</dt>
          <dd>
            {f.trustDelta}, now {f.trust}
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{f.stateLabel}</dd>
        </div>
      </dl>
      {f.appeal && (
        <div className="card" style={{ margin: 0 }}>
          <strong>Appeal</strong>
          <p style={{ margin: '4px 0 0' }}>{f.appeal.reason}</p>
          {f.appeal.note && <p className="muted">{f.appeal.note}</p>}
        </div>
      )}
      {f.decision && (
        <div className="card" style={{ margin: 0 }}>
          <strong>Decision</strong>
          <p style={{ margin: '4px 0 0' }}>{f.decision.reason}</p>
        </div>
      )}
      {canDecide && (
        <>
          <div className="field" data-invalid={tried && !decision}>
            <span>Decision</span>
            <div className="segmented" role="radiogroup" aria-label="Decision">
              {options.map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={decision === k} aria-pressed={decision === k} onClick={() => setDecision(k)}>
                  {l}
                </button>
              ))}
            </div>
            {tried && !decision && <span className="field-error">Choose a decision.</span>}
          </div>
          {decision === 'reduce' && (
            <label className="field" data-invalid={tried && bad.amount}>
              <span>New amount (₦)</span>
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={tried && bad.amount} />
              {tried && bad.amount && <span className="field-error">Enter an amount below {naira(f.amountKobo)}.</span>}
            </label>
          )}
          <label className="field" data-invalid={tried && bad.reason}>
            <span>Reason the citizen reads</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-invalid={tried && bad.reason} placeholder="For example, the neighbour's statement confirms a robbery took place." />
            {tried && bad.reason && <span className="field-error">Give a reason.</span>}
          </label>
        </>
      )}
    </Sheet>
  );
}
