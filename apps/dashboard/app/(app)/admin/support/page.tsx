'use client';
// Help inbox: messages people send from Help and support (and "Message team" on a repair). Staff
// reply here; the person sees the reply in the app and gets a notification. Also lists statements
// waiting for a certified translator check.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, useToast } from '@/components/Agency';
import { HelpChats } from '@/components/HelpChats';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Ticket {
  id: string;
  number: string;
  topic: string;
  body: string;
  state: 'open' | 'answered' | 'closed';
  reply: string | null;
  repliedBy: string | null;
  repliedAt: string | null;
  from: string;
  phone: string | null;
  at: string;
}
interface Inbox {
  counts: Record<string, number>;
  items: Ticket[];
  translatorChecks: { id: string; number: string; note: string; report: string; at: string }[];
}
const TOPIC: Record<string, string> = { report: 'A report', money: 'Money', device: 'Home devices', account: 'Account', app: 'The app', other: 'Other' };
const STATE: Record<Ticket['state'], [string, string]> = { open: ['Waiting', 'warning'], answered: ['Answered', 'success'], closed: ['Closed', 'neutral'] };
type Filter = 'open' | 'answered' | 'closed' | 'all';

/** Help inbox: live chats handed over by the assistant, and written messages (tickets). */
export default function SupportInbox() {
  const [tab, setTab] = useState<'chats' | 'tickets'>('chats');
  const [initial, setInitial] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('chat');
    if (c) setInitial(c);
  }, []);
  const tabs = (
    <div className="segmented tabs" role="tablist" aria-label="Help inbox">
      {(
        [
          ['chats', 'Live chats'],
          ['tickets', 'Messages'],
        ] as const
      ).map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
          {l}
        </button>
      ))}
    </div>
  );
  if (tab === 'tickets') return <TicketsInbox tabs={tabs} />;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Help inbox</h1>
          <p className="lede">The assistant answers first. Chats come here when someone asks for a person or the assistant cannot help.</p>
        </div>
      </div>
      {tabs}
      <HelpChats key={initial ?? 'x'} onToast={setToast} initial={initial} />
    </>
  );
}

function TicketsInbox({ tabs }: { tabs: React.ReactNode }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [d, setD] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Ticket | null>(null);
  const [toast, setToast] = useToast();
  const [loc, setLoc] = useState<LocFilter>({});
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<Inbox>(`/admin/support?status=${filter}${lq ? `&${lq}` : ''}`)
      .then(setD)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load messages.'));
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
          <h1>Help inbox</h1>
          <p className="lede">Messages from citizens and officers. Reply within one working day; they see it in Help and support.</p>
        </div>
      </div>
      {tabs}
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Waiting for a reply</span>
          <strong className="warning">{d ? (d.counts.open ?? 0) : '—'}</strong>
          <small>Oldest first</small>
        </div>
        <div className="stat">
          <span>Answered</span>
          <strong className="success">{d ? (d.counts.answered ?? 0) : '—'}</strong>
          <small>Not closed yet</small>
        </div>
        <div className="stat">
          <span>Translator checks</span>
          <strong>{d ? d.translatorChecks.length : '—'}</strong>
          <small>Statements to check</small>
        </div>
      </div>
      {!!d?.translatorChecks.length && (
        <section className="card" aria-labelledby="tc">
          <h2 id="tc">Statements waiting for a translator</h2>
          {d.translatorChecks.map((t) => (
            <div className="row" key={t.id}>
              <div className="label">
                <strong>
                  {t.number}, {t.report}
                </strong>
                <span>“{t.note}”</span>
              </div>
              <span className="muted">{dateTime(t.at)}</span>
            </div>
          ))}
        </section>
      )}
      <div className="segmented tabs" role="tablist" aria-label="Filter messages">
        {(['open', 'answered', 'closed', 'all'] as Filter[]).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'open' ? 'Waiting' : f[0]!.toUpperCase() + f.slice(1)}
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
            <strong>{filter === 'open' ? 'Nothing waiting.' : 'No messages here.'}</strong>
            People write from Help and support in the app.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Message</th>
                <th>From</th>
                <th>Topic</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((t) => (
                <tr key={t.id} className="link" onClick={() => setOpen(t)}>
                  <td>
                    <button type="button" className="link-btn" style={{ fontWeight: 700, color: 'inherit' }} onClick={(e) => (e.stopPropagation(), setOpen(t))}>
                      {t.number}
                    </button>
                    <div className="muted" style={{ maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.body}
                    </div>
                  </td>
                  <td>
                    {t.from}
                    <div className="muted">{dateTime(t.at)}</div>
                  </td>
                  <td>{TOPIC[t.topic] ?? t.topic}</td>
                  <td>
                    <span className={`chip ${STATE[t.state][1]}`}>{STATE[t.state][0]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && (
        <ReplySheet
          t={open}
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

function ReplySheet({ t, onClose, onDone }: { t: Ticket; onClose: () => void; onDone: (m: string) => void }) {
  const [reply, setReply] = useState(t.reply ?? '');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (close: boolean) => {
    setTried(true);
    if (reply.trim().length < 5) return;
    setBusy(true);
    setErr(null);
    try {
      onDone((await api<{ message: string }>(`/admin/support/${t.id}/reply`, { method: 'POST', body: JSON.stringify({ reply: reply.trim(), close }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title={`${t.number}, ${TOPIC[t.topic] ?? t.topic}`}
      description={`From ${t.from}${t.phone ? `, ${t.phone}` : ''}, ${dateTime(t.at)}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={() => send(true)} disabled={busy}>
            Reply and close
          </button>
          <button className="btn primary" type="button" onClick={() => send(false)} disabled={busy}>
            {busy ? 'Sending…' : 'Send reply'}
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      <div className="card" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        {t.body}
      </div>
      {t.repliedAt && (
        <p className="muted" style={{ margin: 0 }}>
          Last reply by {t.repliedBy}, {dateTime(t.repliedAt)}.
        </p>
      )}
      <label className="field" data-invalid={tried && reply.trim().length < 5}>
        <span>Your reply</span>
        <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={6} maxLength={2000} aria-invalid={tried && reply.trim().length < 5} />
        {tried && reply.trim().length < 5 && <span className="field-error">Write a reply the person will read.</span>}
      </label>
    </Sheet>
  );
}
