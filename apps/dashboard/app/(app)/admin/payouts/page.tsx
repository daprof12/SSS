'use client';
// Platform admin "Donations and payouts" → Payouts (States doc). Payout detail shows
// gross, fees, net, destination bank and second approval; a hold needs a note.
import { formatNaira } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, useToast } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';
import { DateRange, useDateRange } from '@/components/DateRange';

interface Payout {
  id: string;
  agency: string;
  amountKobo: number;
  feeKobo: number;
  netKobo: number;
  state: 'pending' | 'awaiting_second_approval' | 'processing' | 'paid' | 'failed' | 'held';
  reason: string | null;
  requestedBy: string | null;
  approvals: number;
  approvalsNeeded: number;
  approvedByMe: boolean;
  destination: { bank: string; lastFour: string; name: string; verified: boolean } | null;
  holdNote: string | null;
  failureReason: string | null;
  transferCode: string | null;
  createdAt: string;
  paidAt: string | null;
}

/** Bank reasons arrive without a full stop. */
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');
const STATE: Record<Payout['state'], [string, string]> = {
  pending: ['Waiting for approval', 'warning'],
  awaiting_second_approval: ['Needs a second approver', 'warning'],
  processing: ['On its way', 'info'],
  paid: ['Paid', 'success'],
  failed: ['Failed', 'critical'],
  held: ['Held', 'neutral'],
};
type Filter = 'waiting' | 'failed' | 'held' | 'paid' | 'all';
const FILTERS: [Filter, string][] = [
  ['waiting', 'Waiting'],
  ['failed', 'Failed'],
  ['held', 'Held'],
  ['paid', 'Paid'],
  ['all', 'All'],
];
const inFilter = (p: Payout, f: Filter) =>
  f === 'all' || (f === 'waiting' ? ['pending', 'awaiting_second_approval', 'processing'].includes(p.state) : p.state === f);

export default function PayoutsAdmin() {
  const [tab, setTab] = useState<'payouts' | 'donations'>('donations');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Donations and payouts</h1>
          <p className="lede">Money leaving the platform to agencies, stations and officers.</p>
        </div>
      </div>
      <div className="segmented tabs" role="tablist" aria-label="Donations and payouts">
        {(
          [
            ['donations', 'Donations'],
            ['payouts', 'Payouts'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'payouts' ? (
        <Payouts />
      ) : (
        <Donations />
      )}
    </>
  );
}

function Payouts() {
  const [rows, setRows] = useState<Payout[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('waiting');
  const [open, setOpen] = useState<string | null>(null);
  const [toast, setToast] = useToast();

  const load = useCallback(() => {
    api<Payout[]>('/admin/payouts')
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch(setError);
  }, []);
  useEffect(load, [load]);

  const count = (f: Filter) => rows?.filter((r) => inFilter(r, f)).length ?? 0;
  const sum = (list: Payout[]) => naira(list.reduce((s, r) => s + r.amountKobo, 0));
  const waiting = rows?.filter((r) => ['pending', 'awaiting_second_approval'].includes(r.state)) ?? [];
  const failed = rows?.filter((r) => r.state === 'failed') ?? [];
  const month = new Date().toISOString().slice(0, 7);
  const paid = rows?.filter((r) => r.state === 'paid' && r.paidAt?.startsWith(month)) ?? [];
  const shown = rows?.filter((r) => inFilter(r, filter)) ?? [];
  const current = rows?.find((r) => r.id === open) ?? null;

  if (error?.status === 403)
    return (
      <div className="card empty">
        <strong>This page is for platform staff.</strong>
      </div>
    );

  return (
    <div role="tabpanel">
      {toast}
      {error && (
        <div className="banner critical" role="alert">
          <strong>Could not load payouts</strong>
          {error.message}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Waiting for approval</span>
          <strong className={waiting.length ? 'warning' : undefined}>{rows ? waiting.length : '—'}</strong>
          <small>{rows ? sum(waiting) : ''}</small>
        </div>
        <div className="stat">
          <span>Needs your approval</span>
          <strong>{rows ? waiting.filter((r) => !r.approvedByMe).length : '—'}</strong>
          <small>Above the threshold, two people approve</small>
        </div>
        <div className="stat">
          <span>Failed</span>
          <strong className={failed.length ? 'critical' : undefined}>{rows ? failed.length : '—'}</strong>
          <small>Retry or edit the bank details</small>
        </div>
        <div className="stat">
          <span>Paid this month</span>
          <strong className="success">{rows ? sum(paid) : '—'}</strong>
          <small>{paid.length === 1 ? '1 payout' : `${paid.length} payouts`}</small>
        </div>
      </div>

      <div className="segmented tabs" role="tablist" aria-label="Filter payouts">
        {FILTERS.map(([f, l]) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {l} {rows && <span className="count">{count(f)}</span>}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!rows && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : !shown.length ? (
          <div className="empty">
            <strong>{filter === 'waiting' ? 'Nothing waiting.' : 'No payouts here.'}</strong>
            {filter === 'waiting' ? 'Payouts that need approval appear here.' : 'Try another filter.'}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Requested</th>
                <th>Agency</th>
                <th>For</th>
                <th>Gross</th>
                <th>Paid to</th>
                <th>Approvals</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="link" onClick={() => setOpen(r.id)}>
                  <td>{dateTime(r.createdAt)}</td>
                  <td>
                    <button type="button" className="link-btn" style={{ fontWeight: 700, color: 'inherit' }} onClick={(e) => (e.stopPropagation(), setOpen(r.id))}>
                      {r.agency}
                    </button>
                  </td>
                  <td>{r.reason ?? 'Payout'}</td>
                  <td>{naira(r.amountKobo)}</td>
                  <td>{r.destination ? `${r.destination.bank} ••${r.destination.lastFour}` : <span className="chip critical">No account</span>}</td>
                  <td>
                    {r.approvals} of {r.approvalsNeeded}
                  </td>
                  <td>
                    <span className={`chip ${STATE[r.state][1]}`}>{STATE[r.state][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {current && (
        <PayoutSheet
          p={current}
          onClose={() => setOpen(null)}
          onDone={(m) => {
            setOpen(null);
            setToast(m);
            load();
          }}
        />
      )}
    </div>
  );
}

function PayoutSheet({ p, onClose, onDone }: { p: Payout; onClose: () => void; onDone: (m: string) => void }) {
  const [holding, setHolding] = useState(false);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const act = (path: string, body?: unknown) =>
    s.run(async () => {
      const r = await api<{ message: string; state: string }>(`/admin/payouts/${p.id}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      onDone(r.message ?? (r.state === 'processing' ? 'Retry sent. The transfer is on its way.' : 'Done.'));
    });

  const canDecide = ['pending', 'awaiting_second_approval'].includes(p.state);
  const completes = p.approvals + 1 >= p.approvalsNeeded;
  const bankOk = !!p.destination?.verified;

  const footer = holding ? (
    <>
      <button className="btn" type="button" onClick={() => setHolding(false)} disabled={s.busy}>
        Back
      </button>
      <button
        className="btn primary"
        type="button"
        disabled={s.busy}
        onClick={() => {
          setTried(true);
          if (note.trim().length < 3) return focusFirstError();
          void act('hold', { note: note.trim() });
        }}
      >
        {s.busy ? 'Holding…' : 'Hold payout'}
      </button>
    </>
  ) : (
    <>
      {(canDecide || p.state === 'failed') && (
        <button className="btn" type="button" onClick={() => setHolding(true)} disabled={s.busy}>
          Hold
        </button>
      )}
      {p.state === 'held' && (
        <button className="btn primary" type="button" onClick={() => void act('release')} disabled={s.busy}>
          {s.busy ? 'Releasing…' : 'Release for approval'}
        </button>
      )}
      {p.state === 'failed' && (
        <button className="btn primary" type="button" onClick={() => void act('retry')} disabled={s.busy || !bankOk}>
          {s.busy ? 'Sending…' : 'Retry transfer'}
        </button>
      )}
      {canDecide &&
        (p.approvedByMe ? (
          <button className="btn" type="button" disabled>
            Waiting for a second approver
          </button>
        ) : (
          <button className="btn primary" type="button" onClick={() => void act('approve')} disabled={s.busy || !bankOk}>
            {s.busy ? 'Approving…' : completes ? `Approve and send ${naira(p.netKobo)}` : `Approve (1 of ${p.approvalsNeeded})`}
          </button>
        ))}
      {!canDecide && !['failed', 'held'].includes(p.state) && (
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      )}
    </>
  );

  return (
    <Sheet open title={`Payout to ${p.agency}`} description={p.reason ?? undefined} onClose={onClose} busy={s.busy} footer={footer}>
      <ErrorBox error={s.error} />
      {holding ? (
        <label className="field" data-invalid={tried && note.trim().length < 3}>
          <span>Why are you holding it?</span>
          <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-invalid={tried && note.trim().length < 3} placeholder="For example, checking a dispute on a tip" />
          {tried && note.trim().length < 3 && <span className="field-error">Say why you are holding it.</span>}
        </label>
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>Gross</dt>
              <dd>{naira(p.amountKobo)}</dd>
            </div>
            <div>
              <dt>Transfer fee</dt>
              <dd>−{naira(p.feeKobo)}</dd>
            </div>
            <div>
              <dt>Net to the bank</dt>
              <dd>{naira(p.netKobo)}</dd>
            </div>
            <div>
              <dt>Destination</dt>
              <dd>{p.destination ? `${p.destination.bank} ••${p.destination.lastFour}, ${p.destination.name}` : 'No bank account'}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>
                {dateTime(p.createdAt)}
                {p.requestedBy ? ` by ${p.requestedBy}` : ''}
              </dd>
            </div>
            <div>
              <dt>Approvals</dt>
              <dd>
                {p.approvals} of {p.approvalsNeeded}
                {p.approvedByMe ? ' (you approved)' : ''}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`chip ${STATE[p.state][1]}`}>{STATE[p.state][0]}</span>
              </dd>
            </div>
          </dl>
          {!bankOk && (canDecide || p.state === 'failed') && (
            <div className="banner warning" style={{ marginTop: 12 }}>
              <strong>Bank account not verified</strong>Verify the account before the next payout.
            </div>
          )}
          {p.approvalsNeeded > 1 && canDecide && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Above the threshold, two different people must approve. {p.approvedByMe ? 'Another admin must confirm.' : ''}
            </p>
          )}
          {p.state === 'failed' && (
            <div className="banner critical" style={{ marginTop: 12 }}>
              <strong>Payout failed</strong>
              {sentence(p.failureReason ?? 'The bank did not accept the transfer')} Retry or edit the bank details. The money is back in the agency&apos;s balance.
            </div>
          )}
          {p.state === 'held' && p.holdNote && (
            <div className="banner info" style={{ marginTop: 12 }}>
              <strong>Held</strong>
              {p.holdNote}
            </div>
          )}
          {p.transferCode && <p className="muted">Paystack transfer {p.transferCode}</p>}
        </>
      )}
    </Sheet>
  );
}

interface DonationsView {
  stats: { donatedMonthKobo: number; waitingKobo: number; paidOutMonthKobo: number; feePct: number; nextRun: string };
  donations: { id: string; donor: string; recipient: string; level: string; amountKobo: number; netKobo: number; paidVia: string; payout: 'queued' | 'paid' | 'failed'; failure: string | null; at: string }[];
}
const PAYOUT: Record<string, [string, string]> = {
  queued: ['Queued', 'var(--color-warning-text)'],
  paid: ['Paid', 'var(--color-success-text)'],
  failed: ['Failed', 'var(--color-emergency-text)'],
};

/** Board "Donations and payouts": gifts to agencies, stations and officers, by the receiving station's place. */
function Donations() {
  const [loc, setLoc] = useState<LocFilter>({});
  const [d, setD] = useState<DonationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const dates = useDateRange('all');
  const lq = [locQuery(loc), dates.q].filter(Boolean).join('&');
  const load = useCallback(() => {
    api<DonationsView>(`/admin/donations${lq ? `?${lq}` : ''}`)
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load donations.'));
  }, [lq]);
  useEffect(load, [load]);
  const run = async () => {
    setBusy(true);
    try {
      setToast((await api<{ message: string }>('/admin/donations/payout', { method: 'POST', body: '{}' })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not run the payout.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="tabpanel">
      {toast}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn signal" type="button" onClick={run} disabled={busy || !d?.stats.waitingKobo}>
          {busy ? 'Running…' : 'Run payout'}
        </button>
      </div>
      <div className="stats">
        <div className="stat">
          <span>Donated this month</span>
          <strong className="success">{d ? naira(d.stats.donatedMonthKobo) : '—'}</strong>
          <small>Before platform fee</small>
        </div>
        <div className="stat">
          <span>Waiting for payout</span>
          <strong className="warning">{d ? naira(d.stats.waitingKobo) : '—'}</strong>
          <small>Next run {d ? new Date(`${d.stats.nextRun}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''}</small>
        </div>
        <div className="stat">
          <span>Paid out</span>
          <strong>{d ? naira(d.stats.paidOutMonthKobo) : '—'}</strong>
          <small>This month</small>
        </div>
        <div className="stat">
          <span>Platform fee</span>
          <strong className="info">{d ? `${d.stats.feePct}%` : '—'}</strong>
          <small>Set in Settings</small>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} title="Filter by location of the receiving station" />
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="rd">
        <h2 id="rd" style={{ margin: 0, padding: '16px 16px 0' }}>
          Recent donations
        </h2>
        {!d && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !d?.donations.length ? (
          <div className="empty">No donations here yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Donor</th>
                <th>Recipient</th>
                <th>Level</th>
                <th>Amount</th>
                <th>Paid via</th>
                <th>Payout</th>
              </tr>
            </thead>
            <tbody>
              {d.donations.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.donor}</strong>
                    <div className="muted">{dateTime(x.at)}</div>
                  </td>
                  <td>{x.recipient}</td>
                  <td>{x.level}</td>
                  <td>
                    <strong>{naira(x.amountKobo)}</strong>
                    <div className="muted">{naira(x.netKobo)} after fee</div>
                  </td>
                  <td>{x.paidVia}</td>
                  <td>
                    <strong style={{ color: PAYOUT[x.payout]?.[1] }} title={x.failure ?? undefined}>
                      {PAYOUT[x.payout]?.[0]}
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
