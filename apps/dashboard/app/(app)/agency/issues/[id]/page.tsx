'use client';

import Link from 'next/link';
import { use, useCallback, useState } from 'react';
import { api } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { Evidence } from '@/components/Evidence';
import { WithAgency, dateOnly, dateTime, daysSince, plural, shortDate, useAgencyRecord, useToast } from '@/components/Agency';
import { IssueStateChip, isOverdue, severityLabel } from '@/components/IssueChips';
import { IssueShare } from '@/components/IssueShare';

interface IssueView {
  id: string;
  publicNo: string;
  category: string;
  place: string;
  postcode: string | null;
  area: string | null;
  state: string;
  severity: string;
  reports: number;
  people: number;
  firstAt: string;
  lastAt: string;
  targetOn: string | null;
  fixNote: string | null;
  fixConfirmations: number;
  votes: { yes: number; no: number };
  severities: Array<{ value: string; people: number }>;
  subtypes: Array<{ value: string; people: number }>;
  comments: Array<{ text: string; at: string }>;
  perDay: Array<{ day: string; reports: number }>;
  actions: Array<'assign' | 'start' | 'mark_fixed'>;
  history: Array<{ kind: string; label: string; note: string | null; at: string }>;
}

type Kind = 'assign' | 'start' | 'mark_fixed';

/** One public issue case for the agency (board "Agency public issue detail"). */
export default function IssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WithAgency>{() => <IssueDetail id={id} />}</WithAgency>;
}

function IssueDetail({ id }: { id: string }) {
  const { data: v, error, agencyId, reload } = useAgencyRecord<IssueView>((a) => `/agencies/${a}/issues/${id}`);
  const [open, setOpen] = useState<Kind | null>(null);
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
        <strong>{error.status === 404 ? 'This issue is not with your agency.' : 'Could not load this issue'}</strong>
        {error.status !== 404 && <span>{error.message}</span>}
        <Link href="/agency/issues">Back to public issues</Link>
      </div>
    );
  if (!v || !agencyId)
    return (
      <>
        <div className="skeleton" style={{ height: 40, width: 320 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </>
    );

  const today = dateOnly(new Date());
  const open_ = daysSince(v.firstAt);
  const overdue = isOverdue(v, today);
  const past = v.targetOn ? daysSince(`${v.targetOn}T00:00:00`) : 0;
  const top = v.severities[0];
  const max = Math.max(1, ...v.perDay.map((d) => d.reports));
  const path = `/agencies/${agencyId}/issues/${v.id}/actions`;

  return (
    <>
      <p style={{ margin: '0 0 8px' }}>
        <Link href="/agency/issues">← Public issues</Link>
      </p>
      <div className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1>
              {v.category}, {v.postcode ?? 'GPS location'}
            </h1>
            <IssueStateChip state={v.state} />
          </div>
          <p className="lede">
            {v.place}
            {v.area ? `, ${v.area}` : ''}. {open_ === 0 ? 'First reported today' : `First reported ${shortDate(v.firstAt)}, open for ${plural(open_, 'day')}`}. Case {v.publicNo}.
          </p>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <span>People reported</span>
          <strong className={v.people >= 10 ? 'critical' : undefined}>{v.people}</strong>
          <small>{v.reports > v.people ? `${v.reports} reports, ` : ''}counted as one issue</small>
        </div>
        <div className="stat">
          <span>Severity</span>
          <strong className={v.severity === 'blocking' ? 'critical' : v.severity === 'dangerous' ? 'warning' : undefined}>{severityLabel(v.severity)}</strong>
          <small>{top ? `${plural(top.people, 'person', 'people')} chose ${severityLabel(top.value).toLowerCase()}` : 'Highest reported'}</small>
        </div>
        <div className="stat">
          <span>{overdue ? 'Past fix date by' : 'Fix by'}</span>
          <strong className={overdue ? 'warning' : undefined}>{overdue ? plural(past, 'day') : v.targetOn ? shortDate(v.targetOn) : 'Not set'}</strong>
          <small>{v.targetOn ? `Target ${shortDate(v.targetOn)}` : 'Set when you take it on'}</small>
        </div>
        <div className="stat">
          <span>Last report</span>
          <strong>{daysSince(v.lastAt) === 0 ? 'Today' : `${plural(daysSince(v.lastAt), 'day')} ago`}</strong>
          <small>{dateTime(v.lastAt)}</small>
        </div>
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="perday">
          <h2 id="perday">Reports per day</h2>
          <div className="bars" role="img" aria-label={v.perDay.map((d) => `${shortDate(d.day)}: ${d.reports}`).join(', ')}>
            {v.perDay.map((d) => (
              <i key={d.day} style={{ height: `${(d.reports / max) * 100}%` }} title={`${shortDate(d.day)}: ${plural(d.reports, 'report')}`} />
            ))}
          </div>
          <div className="bars-axis">
            <span>{v.perDay[0] ? shortDate(v.perDay[0].day) : ''}</span>
            <span>{v.perDay.length > 1 ? shortDate(v.perDay[v.perDay.length - 1]!.day) : ''}</span>
          </div>
        </section>

        <section className="card" aria-labelledby="say">
          <h2 id="say">Citizens say</h2>
          <dl className="facts">
            {v.severities.map((s) => (
              <div key={s.value}>
                <dt>{severityLabel(s.value)}</dt>
                <dd>{plural(s.people, 'person', 'people')}</dd>
              </div>
            ))}
            {v.subtypes.map((s) => (
              <div key={s.value}>
                <dt>{s.value}</dt>
                <dd>{plural(s.people, 'person', 'people')}</dd>
              </div>
            ))}
          </dl>
          {v.comments.slice(-3).map((c, i) => (
            <p key={i} className="quote">
              {c.text}
            </p>
          ))}
          <Evidence ownerType="issue_case" ownerId={v.id} />
        </section>

        <section className="card" aria-labelledby="act">
          <h2 id="act">Action</h2>
          {v.state === 'awaiting_check' && (
            <div className="banner info" style={{ margin: 0 }}>
              <strong>Waiting for reporters to confirm</strong>
              {v.votes.yes} of {v.fixConfirmations} said it is fixed. One &ldquo;no&rdquo; reopens it.
            </div>
          )}
          {v.state === 'reopened' && (
            <div className="banner critical" style={{ margin: 0 }}>
              <strong>A reporter says it is not fixed.</strong>
              Start the work again, then mark it fixed.
            </div>
          )}
          {v.state === 'fixed' && <p className="muted">Reporters confirmed the fix. Nothing more to do.</p>}
          {v.fixNote && v.state !== 'fixed' && (
            <dl className="facts" style={{ marginTop: 12 }}>
              <div>
                <dt>Your last fix note</dt>
                <dd>{v.fixNote}</dd>
              </div>
            </dl>
          )}
          <div className="actions">
            {v.actions.includes('assign') && (
              <button className="btn signal" type="button" onClick={() => setOpen('assign')}>
                Assign
              </button>
            )}
            {v.actions.includes('start') && (
              <button className={`btn ${v.actions.includes('mark_fixed') ? '' : 'signal'}`} type="button" onClick={() => setOpen('start')}>
                Start work
              </button>
            )}
            {v.actions.includes('mark_fixed') && (
              <button className="btn signal" type="button" onClick={() => setOpen('mark_fixed')}>
                Mark fixed
              </button>
            )}
            {!v.actions.length && !['fixed', 'awaiting_check'].includes(v.state) && <span className="muted">No actions at this stage.</span>}
          </div>
        </section>

        <IssueShare base={`/agencies/${agencyId}/issues/${v.id}`} publicNo={v.publicNo} onToast={setToast} />

        <section className="card" aria-labelledby="hist">
          <h2 id="hist">History</h2>
          <ol className="timeline">
            {v.history.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time dateTime={e.at}>{dateTime(e.at)}</time>
                <span>
                  {e.label}
                  {e.note && <span style={{ display: 'block', color: 'var(--color-text-secondary)', fontSize: 13 }}>{e.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {open === 'assign' && <AssignSheet path={path} onClose={close} onDone={done} />}
      {open === 'start' && <StartSheet path={path} onClose={close} onDone={done} />}
      {open === 'mark_fixed' && <FixedSheet path={path} confirmations={v.fixConfirmations} onClose={close} onDone={done} />}
      {toast}
    </>
  );
}

interface SheetProps {
  path: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}

function AssignSheet({ path, onClose, onDone }: SheetProps) {
  const [date, setDate] = useState('');
  const [who, setWho] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const today = dateOnly(new Date());
  const err = !date ? 'Pick a date to fix it by.' : date <= today ? 'Pick a date after today.' : null;

  return (
    <Sheet
      open
      title="Assign this issue"
      description="Reporters are told you have taken it on and when it should be fixed."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (err) return focusFirstError();
              void s.run(async () => {
                await api(path, { method: 'POST', body: JSON.stringify({ event: 'assign', targetOn: date, note: who.trim() || undefined }) });
                onDone(`Assigned. Fix by ${shortDate(date)}.`);
              });
            }}
          >
            {s.busy ? 'Saving…' : 'Assign issue'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && !!err}>
        <span>Fix by</span>
        <input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={tried && !!err} />
        {tried && err && <span className="field-error">{err}</span>}
      </label>
      <label className="field">
        <span>Who is doing it (optional)</span>
        <input type="text" placeholder="Contractor or team" value={who} onChange={(e) => setWho(e.target.value)} maxLength={200} />
      </label>
    </Sheet>
  );
}

function StartSheet({ path, onClose, onDone }: SheetProps) {
  const [note, setNote] = useState('');
  const s = useSubmit();
  return (
    <Sheet
      open
      title="Start work"
      description="Reporters are told work has started."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() =>
              s.run(async () => {
                await api(path, { method: 'POST', body: JSON.stringify({ event: 'start', note: note.trim() || undefined }) });
                onDone('Work started. Reporters were told.');
              })
            }
          >
            {s.busy ? 'Starting…' : 'Start work'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field">
        <span>Note (optional)</span>
        <textarea placeholder="For example, crew on site this week" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </label>
    </Sheet>
  );
}

function FixedSheet({ path, confirmations, onClose, onDone }: SheetProps & { confirmations: number }) {
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const invalid = note.trim().length < 3;
  return (
    <Sheet
      open
      title="Mark fixed"
      description="Reporters are asked if it is fixed. It closes when they confirm."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (invalid) return focusFirstError();
              void s.run(async () => {
                await api(path, { method: 'POST', body: JSON.stringify({ event: 'mark_fixed', note: note.trim() }) });
                onDone('Marked fixed. Reporters are asked to confirm.');
              });
            }}
          >
            {s.busy ? 'Saving…' : 'Mark fixed'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <div className="banner info" style={{ margin: 0 }}>
        <strong>Reporters check the fix</strong>
        We ask {plural(confirmations, 'reporter')} to confirm, then close it. One &ldquo;no&rdquo; reopens it.
      </div>
      <label className="field" data-invalid={tried && invalid}>
        <span>What was done</span>
        <textarea placeholder="For example, pothole filled and resurfaced" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={tried && invalid} />
        {tried && invalid && <span className="field-error">Say what was done.</span>}
      </label>
    </Sheet>
  );
}
