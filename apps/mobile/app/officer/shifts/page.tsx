'use client';
// Duty and shifts: today's status and the next two weeks of the roster.
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { clockTime } from '@/components/officer/work';
import { api, ApiError } from '@/lib/client';

interface Req {
  id: string;
  kind: 'swap' | 'leave';
  state: 'waiting' | 'approved' | 'declined' | 'withdrawn';
  line: string;
  mine: boolean;
  declineReason: string | null;
}
const REQ: Record<Req['state'], [string, string]> = { waiting: ['Waiting', 'warning'], approved: ['Approved', 'success'], declined: ['Declined', 'critical'], withdrawn: ['Withdrawn', 'neutral'] };

interface Shifts {
  onDuty: boolean;
  shifts: { startsAt: string; endsAt: string; kind: string; vehicle: string | null }[];
}
const KIND: Record<string, [string, string]> = { day: ['Day shift', 'info'], night: ['Night shift', 'info'], off: ['Off', 'neutral'], leave: ['On leave', 'warning'] };

export default function MyShifts() {
  const [s, setS] = useState<Shifts | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [asking, setAsking] = useState<'swap' | 'leave' | null>(null);
  const [toast, setToast] = useToast();
  const load = () => {
    api<Shifts>('/me/officer/shifts').then(setS).catch(() => setS({ onDuty: false, shifts: [] }));
    api<Req[]>('/me/officer/roster-requests').then(setReqs).catch(() => setReqs([]));
  };
  useEffect(load, []);
  return (
    <main className="app">
      <Header title="Duty and shifts" back="/officer/profile" />
      <div className={`banner ${s?.onDuty ? 'success' : 'info'}`}>
        <strong>{s ? (s.onDuty ? 'You are on duty' : 'You are off duty') : 'Checking…'}</strong>
        {s?.onDuty ? 'You receive dispatch offers near you.' : 'Go on duty from Home to receive offers.'} <Link href="/officer">Open Home</Link>
      </div>
      <p className="section-label">Next two weeks</p>
      {!s ? (
        <div className="skeleton" />
      ) : !s.shifts.length ? (
        <div className="card empty">
          <strong>No shifts on the roster.</strong>Your station head sets the roster. Ask them if this looks wrong.
        </div>
      ) : (
        <div className="list">
          {s.shifts.map((x, i) => (
            <div key={i} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{new Date(x.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</strong>
                <span className="sub">
                  {x.kind === 'day' || x.kind === 'night' ? `${clockTime(x.startsAt)} to ${clockTime(x.endsAt)}` : 'No duty'}
                  {x.vehicle ? ` · ${x.vehicle}` : ''}
                </span>
              </span>
              <span className={`chip ${KIND[x.kind]?.[1] ?? 'neutral'}`}>{KIND[x.kind]?.[0] ?? x.kind}</span>
            </div>
          ))}
        </div>
      )}
      <p className="section-label">Swaps and leave</p>
      <div className="btn-row">
        <button className="btn" type="button" onClick={() => setAsking('swap')}>
          Ask for a swap
        </button>
        <button className="btn" type="button" onClick={() => setAsking('leave')}>
          Ask for leave
        </button>
      </div>
      {!!reqs?.length && (
        <div className="list" style={{ marginTop: 12 }}>
          {reqs.map((q) => (
            <div key={q.id} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{q.mine ? q.line : `Asked of you: ${q.line}`}</strong>
                {q.declineReason && <span className="sub">{q.declineReason}</span>}
              </span>
              {q.state === 'waiting' && q.mine ? (
                <button
                  className="link-btn"
                  type="button"
                  onClick={async () => {
                    await api(`/me/officer/roster-requests/${q.id}/withdraw`, { method: 'POST' }).catch(() => {});
                    load();
                  }}
                >
                  Withdraw
                </button>
              ) : (
                <span className={`chip ${REQ[q.state][1]}`}>{REQ[q.state][0]}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="muted">Your station head approves; the roster updates and both officers are told.</p>
      {asking && (
        <RequestSheet
          kind={asking}
          shifts={s?.shifts ?? []}
          onClose={() => setAsking(null)}
          onDone={(m) => {
            setAsking(null);
            setToast(m);
            load();
          }}
        />
      )}
      <Toast msg={toast} />
    </main>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function RequestSheet({ kind, shifts, onClose, onDone }: { kind: 'swap' | 'leave'; shifts: Shifts['shifts']; onClose: () => void; onDone: (m: string) => void }) {
  const [mates, setMates] = useState<{ id: string; name: string }[]>([]);
  const [mate, setMate] = useState('');
  const mine = shifts.filter((x) => x.kind === 'day' || x.kind === 'night');
  const [myDate, setMyDate] = useState(mine[0] ? iso(new Date(mine[0].startsAt)) : iso(new Date()));
  const [otherDate, setOtherDate] = useState(iso(new Date(Date.now() + 86_400_000)));
  const [from, setFrom] = useState(iso(new Date(Date.now() + 86_400_000)));
  const [to, setTo] = useState(iso(new Date(Date.now() + 2 * 86_400_000)));
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind !== 'swap') return;
    api<{ members: { id: string; name: string; you: boolean }[] }>('/me/officer/team')
      .then((t) => setMates(t.members.filter((m) => !m.you)))
      .catch(() => {});
  }, [kind]);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = kind === 'swap' ? { kind, otherOfficerId: mate, myDate, otherDate, note } : { kind, fromDate: from, toDate: to, note };
      onDone((await api<{ message: string }>('/me/officer/roster-requests', { method: 'POST', body: JSON.stringify(body) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title={kind === 'swap' ? 'Ask for a shift swap' : 'Ask for leave'}
      description={kind === 'swap' ? 'You give up your shift on one day and take your teammate’s shift on another.' : 'Your station head approves before the roster changes.'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={send} disabled={busy || (kind === 'swap' && !mate)}>
            {busy ? 'Sending…' : 'Send to station head'}
          </button>
        </>
      }
    >
      {kind === 'swap' ? (
        <>
          <label className="field">
            <span>Swap with</span>
            <select value={mate} onChange={(e) => setMate(e.target.value)}>
              <option value="">Choose a teammate…</option>
              {mates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>My shift to give up</span>
            <input type="date" value={myDate} min={iso(new Date())} onChange={(e) => setMyDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Their shift I take</span>
            <input type="date" value={otherDate} min={iso(new Date())} onChange={(e) => setOtherDate(e.target.value)} />
          </label>
        </>
      ) : (
        <>
          <label className="field">
            <span>First day of leave</span>
            <input type="date" value={from} min={iso(new Date())} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span>Last day of leave</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </>
      )}
      <label className="field" style={{ marginBottom: 0 }}>
        <span>Note (optional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </label>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}
