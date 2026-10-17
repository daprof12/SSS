'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';
import { Attachments, AttachPicker, uploadPicked, usePicked } from './Attach';

interface Tip {
  publicNo: string;
  category: string;
  agency: string;
  description: string;
  place: string | null;
  anonymous: boolean;
  state: string;
  status: { title: string; chip: string; tone: string };
  steps: Array<{ key: string; label: string; sub: string; at: string | null; done: boolean }>;
  bountyRange: string | null;
  bounty: { amount: string; releaseAt: string | null } | null;
  updates: Array<{ kind: string; text: string; at: string }>;
  canAddInfo: boolean;
  canWithdraw: boolean;
  createdAt: string;
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'Waiting');

/** Tip detail (board "Tip detail"): status chip, timeline, bounty, add info, withdraw. */
export function TipDetail({ id, back }: { id: string; back: string }) {
  const sent = useSearchParams().get('sent') === '1';
  const [t, setT] = useState<Tip | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'info' | 'withdraw' | null>(null);
  const [toast, setToast] = useToast();
  const [files, setFiles] = useState(0);

  const load = useCallback(
    () =>
      api<Tip>(`/tips/${id}`)
        .then(setT)
        .catch((e: ApiError) => setErr(e.message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (sent) setToast('Tip sent. Thank you.');
  }, [sent, setToast]);

  if (err) return <main className="app bare"><Header back={back} /><div className="card empty"><strong>{err}</strong></div></main>;
  if (!t) return <main className="app bare">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 90 }} />)}</main>;

  const moreInfo = t.updates.filter((u) => u.kind === 'ask_more').pop();
  return (
    <main className="app bare">
      <Header title={`Tip ${t.publicNo}`} back={back}>
        <span className={`chip ${t.status.tone}`}>{t.status.chip}</span>
      </Header>

      {t.state === 'more_info' && moreInfo && (
        <div className="banner warning" role="status">
          <strong>{t.agency} asks</strong>“{moreInfo.text}”
        </div>
      )}

      <div className="card">
        <span className="muted">
          {t.category}, sent {day(t.createdAt)}
          {t.place ? ` · ${t.place}` : ''}
        </span>
        <p style={{ margin: '6px 0 0' }}>{t.description}</p>
      </div>

      <div className="card">
        <ol className="steps" style={{ gridTemplateColumns: '1fr', margin: 0 }} aria-label="Progress">
          {t.steps.map((s, i) => {
            const now = !s.done && (i === 0 || t.steps[i - 1]!.done);
            return (
              <li key={s.key} className={s.done ? 'done' : now ? 'now' : ''} style={{ alignItems: 'flex-start' }}>
                <i aria-hidden style={{ marginTop: 4 }} />
                <span style={{ flex: 1 }}>
                  {s.label}
                  <span className="sub" style={{ display: 'block', fontWeight: 400, color: 'var(--color-text-secondary)' }}>
                    {s.sub}
                  </span>
                </span>
                <span className="muted">{day(s.at)}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {t.bounty ? (
        <div className="banner success" style={{ display: 'flex', gap: 12 }}>
          <Icon name="money" />
          <span>
            <strong>Bounty {t.bounty.amount}</strong>
            In your wallet{t.bounty.releaseAt ? `, ready to withdraw on ${day(t.bounty.releaseAt)}` : ''}. <Link href={back.startsWith('/officer') ? '/officer/wallet' : '/wallet'}>Open wallet</Link>
          </span>
        </div>
      ) : (
        t.bountyRange &&
        ['sent', 'in_queue', 'more_info', 'claim_review'].includes(t.state) && (
          <div className="banner warning" style={{ display: 'flex', gap: 12 }}>
            <Icon name="money" />
            <span>
              <strong>Possible bounty {t.bountyRange}</strong>
              Paid if the agency records a result. The first reporter keeps the claim.
            </span>
          </div>
        )
      )}
      {t.status.tone === 'critical' && (
        <div className="banner critical">
          <strong>{t.status.title}</strong>It affects your trust score. You can appeal from Fines and appeals.
        </div>
      )}

      <p className="muted">{t.anonymous ? 'Your name is hidden from the agency.' : 'The agency can see your name.'}</p>

      <Attachments ownerType="tip" ownerId={id} refreshKey={files} title="Your photos and videos" />
      {t.canAddInfo && (
        <button className="btn block signal" type="button" onClick={() => setSheet('info')}>
          Add more information
        </button>
      )}
      {t.canWithdraw && (
        <button className="link-btn" type="button" onClick={() => setSheet('withdraw')} style={{ display: 'block', margin: '8px auto 0', color: 'var(--color-emergency-text)' }}>
          Withdraw this tip
        </button>
      )}

      {sheet === 'info' && <InfoSheet id={id} onClose={() => setSheet(null)} onDone={() => { setSheet(null); setToast('Sent to the agency.'); setFiles((k) => k + 1); void load(); }} />}
      <Sheet
        open={sheet === 'withdraw'}
        title="Withdraw this tip?"
        description={`${t.agency} stops working on it and no bounty can be paid. This cannot be undone.`}
        onClose={() => setSheet(null)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setSheet(null)}>
              Keep my tip
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                try {
                  await api(`/tips/${id}/withdraw`, { method: 'POST' });
                  setToast('Tip withdrawn.');
                } catch (e) {
                  setToast(e instanceof ApiError ? e.message : 'Could not withdraw.');
                }
                setSheet(null);
                void load();
              }}
            >
              Withdraw tip
            </button>
          </>
        }
      >
        <span />
      </Sheet>
      <Toast msg={toast} />
    </main>
  );
}

function InfoSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = usePicked();
  return (
    <Sheet
      open
      title="Add more information"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={busy}
            onClick={async () => {
              const n = picked.items.length;
              if (text.trim().length < 3 && !n) return setErr('Write a little more, or add a photo.');
              setBusy(true);
              try {
                if (n && (await uploadPicked('tip', id, picked))) return setBusy(false);
                const note = text.trim().length >= 3 ? text.trim() : `Added ${n} ${n === 1 ? 'file' : 'files'}.`;
                await api(`/tips/${id}/info`, { method: 'POST', body: JSON.stringify({ text: note }) });
                onDone();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not send.');
                setBusy(false);
              }
            }}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      }
    >
      <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
        <span>What else should the agency know?</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} aria-invalid={!!err} />
      </label>
      {err && <span className="field-error">{err}</span>}
      <div style={{ marginTop: 12 }}>
        <AttachPicker picked={picked} disabled={busy} />
      </div>
    </Sheet>
  );
}
