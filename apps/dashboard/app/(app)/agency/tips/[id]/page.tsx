'use client';

import { formatNaira, suggestBounty } from '@erp/domain';
import Link from 'next/link';
import { use, useCallback, useRef, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { Evidence } from '@/components/Evidence';
import { WithAgency, dateTime, plural, useAgencyRecord, useToast } from '@/components/Agency';
import { OUTCOMES, TipStateChip, outcomeLabel } from '@/components/IssueChips';

type Event = 'ask_more' | 'outcome_recorded' | 'approve' | 'decline' | 'close' | 'mark_false';

interface TipView {
  id: string;
  publicNo: string;
  category: string;
  state: string;
  description: string;
  place: string | null;
  tipper: string;
  createdAt: string;
  claim: { outcome: string; severity: 'standard' | 'high' | null; suggestedKobo: number; approvedKobo: number | null; declineReason: string | null; recoveredKobo: number | null; recordedAt: string } | null;
  rate: { basis: 'fixed' | 'tiered' | 'percent_capped'; percent: number | null; minKobo: number | null; maxKobo: number | null; capKobo: number | null } | null;
  poolKobo: number | null;
  holdDays: number;
  actions: Event[];
  history: Array<{ kind: string; label: string; note: string | null; amountKobo: number | null; at: string }>;
}

const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');

/** One tip and its bounty claim (board "Agency bounty claim detail"). */
export default function TipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WithAgency>{() => <TipDetail id={id} />}</WithAgency>;
}

function TipDetail({ id }: { id: string }) {
  const { data: v, error, agencyId, reload } = useAgencyRecord<TipView>((a) => `/agencies/${a}/tips/${id}`);
  const [open, setOpen] = useState<Event | null>(null);
  const [toast, setToast] = useToast();
  const close = useCallback(() => setOpen(null), []);
  const done = (msg: string) => {
    setOpen(null);
    setToast(msg);
    reload();
  };

  if (error)
    return (
      <div className="card empty">
        <strong>{error.status === 404 ? 'This tip is not with your agency.' : 'Could not load this tip'}</strong>
        {error.status !== 404 && <span>{error.message}</span>}
        <Link href="/agency/bounties">Back to bounties</Link>
      </div>
    );
  if (!v || !agencyId)
    return (
      <>
        <div className="skeleton" style={{ height: 40, width: 320 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </>
    );

  const path = `/agencies/${agencyId}/tips/${v.id}/actions`;
  const can = (e: Event) => v.actions.includes(e);
  const c = v.claim;
  const props = { path, onClose: close, onDone: done };

  return (
    <>
      <p style={{ margin: '0 0 8px' }}>
        <Link href="/agency/bounties">← Bounties</Link>
      </p>
      <div className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1>
              {c ? 'Claim: ' : ''}Tip {v.publicNo}
            </h1>
            <TipStateChip state={v.state} />
          </div>
          <p className="lede">
            {v.category}, {c ? `result recorded ${dateTime(c.recordedAt)}` : `received ${dateTime(v.createdAt)}`}
          </p>
        </div>
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="tip">
          <h2 id="tip">Tip</h2>
          <dl className="facts">
            <div>
              <dt>Category</dt>
              <dd>{v.category}</dd>
            </div>
            <div>
              <dt>Tipper</dt>
              <dd>{v.tipper}</dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>{dateTime(v.createdAt)}</dd>
            </div>
            <div>
              <dt>Place</dt>
              <dd>{v.place ?? 'Not given'}</dd>
            </div>
          </dl>
          <p className="quote">{v.description}</p>
          <Evidence ownerType="tip" ownerId={v.id} />
        </section>

        <div className="grid" style={{ alignContent: 'start' }}>
          {c && (
            <section className="card" aria-labelledby="outcome">
              <h2 id="outcome">Outcome you recorded</h2>
              <dl className="facts">
                <div>
                  <dt>Result</dt>
                  <dd>{outcomeLabel(c.outcome)}</dd>
                </div>
                <div>
                  <dt>Severity</dt>
                  <dd>{c.severity === 'high' ? 'High' : 'Standard'}</dd>
                </div>
                {c.recoveredKobo != null && (
                  <div>
                    <dt>Value recovered</dt>
                    <dd>{naira(c.recoveredKobo)}</dd>
                  </div>
                )}
                {c.declineReason && (
                  <div>
                    <dt>Declined because</dt>
                    <dd>{c.declineReason}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}
          <section className="card" aria-labelledby="pay">
            <h2 id="pay">Payment</h2>
            <dl className="facts">
              {c && (
                <div>
                  <dt>Suggested by rate</dt>
                  <dd>{naira(c.suggestedKobo)}</dd>
                </div>
              )}
              {!c && v.rate?.minKobo != null && (
                <div>
                  <dt>Your rate</dt>
                  <dd>
                    {naira(v.rate.minKobo)}
                    {v.rate.maxKobo != null && v.rate.maxKobo !== v.rate.minKobo ? ` to ${naira(v.rate.maxKobo)}` : ''}
                  </dd>
                </div>
              )}
              {v.rate?.capKobo != null && (
                <div>
                  <dt>Cap per tip</dt>
                  <dd>{naira(v.rate.capKobo)}</dd>
                </div>
              )}
              {c?.approvedKobo != null && (
                <div>
                  <dt>Paid to tipper</dt>
                  <dd style={{ color: 'var(--color-success-text)' }}>{naira(c.approvedKobo)}</dd>
                </div>
              )}
              <div>
                <dt>Bounty pool</dt>
                <dd>{v.poolKobo == null ? 'No pool yet' : naira(v.poolKobo)}</dd>
              </div>
              <div>
                <dt>Held for</dt>
                <dd>{plural(v.holdDays, 'day')}</dd>
              </div>
            </dl>
            {!v.rate && <p className="muted" style={{ marginBottom: 0 }}>No bounty rate is set for this category.</p>}
          </section>
        </div>

        <section className="card" aria-labelledby="decide">
          <h2 id="decide">Decision</h2>
          <div className="banner info" style={{ margin: 0 }}>
            <strong>The tipper&rsquo;s identity stays with us</strong>
            You see {v.tipper.startsWith('Anonymous') ? 'an anonymous number' : 'their name because they agreed'}. Our team verifies who they are and pays their wallet.
          </div>
          <div className="actions">
            {can('outcome_recorded') && (
              <button className="btn signal" type="button" onClick={() => setOpen('outcome_recorded')}>
                Record result
              </button>
            )}
            {can('approve') && (
              <button className="btn signal" type="button" onClick={() => setOpen('approve')}>
                Approve and pay
              </button>
            )}
            {can('ask_more') && (
              <button className="btn" type="button" onClick={() => setOpen('ask_more')}>
                Ask for more
              </button>
            )}
            {can('decline') && (
              <button className="btn danger" type="button" onClick={() => setOpen('decline')}>
                Decline
              </button>
            )}
            {can('close') && (
              <button className="btn" type="button" onClick={() => setOpen('close')}>
                Close
              </button>
            )}
            {can('mark_false') && (
              <button className="btn" type="button" onClick={() => setOpen('mark_false')}>
                Mark false
              </button>
            )}
            {!v.actions.length && <span className="muted">{v.state === 'more_info' ? 'Waiting for the tipper to answer.' : 'No actions at this stage.'}</span>}
          </div>
        </section>

        <section className="card" aria-labelledby="hist">
          <h2 id="hist">History</h2>
          <ol className="timeline">
            {v.history.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time dateTime={e.at}>{dateTime(e.at)}</time>
                <span>
                  {e.label}
                  {e.amountKobo != null && `, ${naira(e.amountKobo)}`}
                  {e.note && <span style={{ display: 'block', color: 'var(--color-text-secondary)', fontSize: 13 }}>{e.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {open === 'ask_more' && <AskMoreSheet {...props} />}
      {open === 'outcome_recorded' && <ResultSheet {...props} rate={v.rate} />}
      {open === 'approve' && <ApproveSheet {...props} tip={v} />}
      {open === 'decline' && <ReasonSheet {...props} kind="decline" />}
      {open === 'mark_false' && <ReasonSheet {...props} kind="mark_false" />}
      {open === 'close' && <CloseSheet {...props} />}
      {toast}
    </>
  );
}

interface SheetProps {
  path: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}

const post = (path: string, body: Record<string, unknown>) => api(path, { method: 'POST', body: JSON.stringify(body) });

function Footer({ onClose, busy, label, busyLabel, tone = 'signal', onConfirm, cancel = 'Cancel' }: { onClose: () => void; busy: boolean; label: string; busyLabel: string; tone?: string; onConfirm: () => void; cancel?: string }) {
  return (
    <>
      <button className="btn" type="button" onClick={onClose} disabled={busy}>
        {cancel}
      </button>
      <button className={`btn ${tone}`} type="button" disabled={busy} onClick={onConfirm}>
        {busy ? busyLabel : label}
      </button>
    </>
  );
}

function AskMoreSheet({ path, onClose, onDone }: SheetProps) {
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const invalid = text.trim().length < 3;
  return (
    <Sheet
      open
      title="Ask for more"
      description="The tipper gets your question in the app. They answer without you seeing who they are."
      onClose={onClose}
      busy={s.busy}
      footer={
        <Footer
          onClose={onClose}
          busy={s.busy}
          label="Send question"
          busyLabel="Sending…"
          onConfirm={() => {
            setTried(true);
            if (invalid) return focusFirstError();
            void s.run(async () => {
              await post(path, { event: 'ask_more', comment: text.trim() });
              onDone('Question sent to the tipper.');
            });
          }}
        />
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && invalid}>
        <span>What do you need?</span>
        <textarea placeholder="For example, which house number?" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} aria-invalid={tried && invalid} />
        {tried && invalid && <span className="field-error">Say what you need from the tipper.</span>}
      </label>
    </Sheet>
  );
}

function ResultSheet({ path, onClose, onDone, rate }: SheetProps & { rate: TipView['rate'] }) {
  const [outcome, setOutcome] = useState('');
  const [severity, setSeverity] = useState<'standard' | 'high'>('standard');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const [recovered, setRecovered] = useState('');
  const byValue = rate?.basis === 'percent_capped';
  const recoveredKobo = Math.round(Number(recovered.replace(/[,\s₦]/g, '')) * 100) || 0;
  const suggested = rate
    ? suggestBounty({ basis: rate.basis, tiers: { min: rate.minKobo, max: rate.maxKobo, percent: rate.percent }, capKobo: rate.capKobo }, { severity, recoveredKobo })
    : null;
  return (
    <Sheet
      open
      title="Record result"
      description="The tipper is told their tip led to a result. The bounty then waits for your approval."
      onClose={onClose}
      busy={s.busy}
      footer={
        <Footer
          onClose={onClose}
          busy={s.busy}
          label="Record result"
          busyLabel="Saving…"
          onConfirm={() => {
            setTried(true);
            if (!outcome || (byValue && !recoveredKobo)) return focusFirstError();
            void s.run(async () => {
              await post(path, { event: 'outcome_recorded', outcome, severity, ...(recoveredKobo ? { recoveredKobo } : {}) });
              onDone('Result recorded. The claim is ready to review.');
            });
          }}
        />
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && !outcome}>
        <span>Result</span>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-invalid={tried && !outcome}>
          <option value="">Choose the result</option>
          {OUTCOMES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {tried && !outcome && <span className="field-error">Choose the result.</span>}
      </label>
      <div className="field">
        <span>Severity</span>
        <div className="segmented" role="group" aria-label="Severity">
          {(
            [
              ['standard', 'Standard'],
              ['high', 'High'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={severity === k} onClick={() => setSeverity(k)}>
              {l}
            </button>
          ))}
        </div>
        {!byValue && <small>{suggested != null ? `Suggested bounty: ${naira(suggested)}, from your rate.` : 'No bounty rate is set for this category.'}</small>}
      </div>
      {byValue && (
        <label className="field" data-invalid={tried && !recoveredKobo} style={{ marginTop: 12 }}>
          <span>Value recovered or seized (₦)</span>
          <input inputMode="decimal" value={recovered} onChange={(e) => setRecovered(e.target.value)} aria-invalid={tried && !recoveredKobo} />
          {tried && !recoveredKobo ? (
            <span className="field-error">Enter the value recovered or seized. This rate pays a share of it.</span>
          ) : (
            <small>
              Your rate pays {rate!.percent}%{rate!.capKobo != null ? `, up to ${naira(rate!.capKobo)}` : ''}.{recoveredKobo ? ` Suggested bounty: ${naira(suggested ?? 0)}.` : ''}
            </small>
          )}
        </label>
      )}
    </Sheet>
  );
}

function ApproveSheet({ path, onClose, onDone, tip }: SheetProps & { tip: TipView }) {
  const initial = tip.claim?.suggestedKobo ? String(tip.claim.suggestedKobo / 100) : '';
  const [amount, setAmount] = useState(initial);
  const [tried, setTried] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const naira_ = Number(amount.replace(/[,\s₦]/g, ''));
  const kobo = Number.isFinite(naira_) ? Math.round(naira_ * 100) : NaN;
  const localError = !amount.trim() ? 'Enter the bounty amount.' : !(kobo > 0) ? 'Enter an amount in naira, like 50000.' : null;
  const shownError = (tried && localError) || fieldError;

  const approve = async () => {
    setTried(true);
    setFieldError(null);
    setError(null);
    if (localError) return focusFirstError();
    setBusy(true);
    try {
      await post(path, { event: 'approve', amountKobo: kobo });
      onDone(`${naira(kobo)} approved. The tipper can withdraw it in ${plural(tip.holdDays, 'day')}.`);
    } catch (e) {
      // Cap, pool and conflict refusals come from the API; show them as they are.
      const msg = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
      if (e instanceof ApiError && (e.code === 'over_cap' || e.code === 'amount_required')) {
        setFieldError(msg);
        requestAnimationFrame(() => input.current?.focus());
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      title="Approve and pay"
      description={`Paid from your bounty pool into the tipper's wallet. They can withdraw it after ${plural(tip.holdDays, 'day')}.`}
      onClose={onClose}
      busy={busy}
      footer={<Footer onClose={onClose} busy={busy} label={kobo > 0 ? `Pay ${naira(kobo)}` : 'Approve and pay'} busyLabel="Paying…" onConfirm={approve} />}
    >
      <ErrorBox error={error} />
      <label className="field" data-invalid={!!shownError}>
        <span>Bounty to pay (₦)</span>
        <input
          ref={input}
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setFieldError(null);
          }}
          aria-invalid={!!shownError}
        />
        {shownError ? (
          <span className="field-error">{shownError}</span>
        ) : (
          <small>
            {tip.claim ? `Suggested ${naira(tip.claim.suggestedKobo)}` : ''}
            {tip.rate?.capKobo != null ? `${tip.claim ? '. ' : ''}Cap ${naira(tip.rate.capKobo)}` : ''}
            {tip.poolKobo != null ? `. Pool has ${naira(tip.poolKobo)}.` : ''}
          </small>
        )}
      </label>
    </Sheet>
  );
}

const DECLINE_REASONS = ['Result not linked to this tip', 'Someone reported it first', 'Not covered by a bounty', 'Other'];

function ReasonSheet({ path, onClose, onDone, kind }: SheetProps & { kind: 'decline' | 'mark_false' }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const decline = kind === 'decline';
  const full = decline ? (reason === 'Other' ? note.trim() : [reason, note.trim()].filter(Boolean).join('. ')) : note.trim();
  const invalid = full.length < 3;

  return (
    <Sheet
      open
      title={decline ? 'Decline bounty' : 'Mark tip false'}
      description={decline ? 'The tipper is told the tip did not qualify for a bounty, and sees your reason.' : 'Use this only when the tip was made up or knowingly wrong. The tipper sees your reason.'}
      onClose={onClose}
      busy={s.busy}
      footer={
        <Footer
          onClose={onClose}
          busy={s.busy}
          tone="danger"
          cancel={decline ? 'Cancel' : 'Keep tip'}
          label={decline ? 'Decline bounty' : 'Mark false'}
          busyLabel={decline ? 'Declining…' : 'Saving…'}
          onConfirm={() => {
            setTried(true);
            if (invalid) return focusFirstError();
            void s.run(async () => {
              await post(path, { event: kind, reason: full });
              onDone(decline ? 'Bounty declined. The tipper was told.' : 'Tip marked false.');
            });
          }}
        />
      }
    >
      <ErrorBox error={s.error} />
      {!decline && (
        <div className="banner warning" style={{ margin: 0 }}>
          <strong>This lowers the tipper&rsquo;s trust score</strong>
          Their score drops by 10 and they are told. They can appeal.
        </div>
      )}
      {decline ? (
        <div className="field" data-invalid={tried && invalid}>
          <span>Reason</span>
          <div className="chips" role="group" aria-label="Decline reason">
            {DECLINE_REASONS.map((o) => (
              <button key={o} type="button" aria-pressed={reason === o} onClick={() => setReason(o)}>
                {o}
              </button>
            ))}
          </div>
          <textarea placeholder={reason === 'Other' ? 'Say why' : 'Add a note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-label="Note" />
          {tried && invalid && <span className="field-error">A reason is required.</span>}
        </div>
      ) : (
        <label className="field" data-invalid={tried && invalid}>
          <span>Why is it false?</span>
          <textarea placeholder="For example, the address does not exist" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={tried && invalid} />
          {tried && invalid && <span className="field-error">Say why the tip is false.</span>}
        </label>
      )}
    </Sheet>
  );
}

function CloseSheet({ path, onClose, onDone }: SheetProps) {
  const [note, setNote] = useState('');
  const s = useSubmit();
  return (
    <Sheet
      open
      title="Close tip"
      description="The tipper is told you closed it without a result. No bounty is paid and their trust is not affected."
      onClose={onClose}
      busy={s.busy}
      footer={
        <Footer
          onClose={onClose}
          busy={s.busy}
          label="Close tip"
          busyLabel="Closing…"
          cancel="Keep open"
          onConfirm={() =>
            s.run(async () => {
              await post(path, { event: 'close', reason: note.trim() || undefined });
              onDone('Tip closed.');
            })
          }
        />
      }
    >
      <ErrorBox error={s.error} />
      <label className="field">
        <span>Message to the tipper (optional)</span>
        <textarea placeholder="For example, not enough to act on" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </label>
    </Sheet>
  );
}
