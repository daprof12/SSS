'use client';
// View-only issue brief for someone outside the platform (a superior, another office).
// No sign-in, no reporter identities, no actions. Expires on the date shown.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { API_URL } from '@erp/web-ui/api';
import { applyTheme, readTheme, type ThemeChoice } from '@erp/web-ui/theme';
import { ThemeSwitch } from '@erp/web-ui/ThemeSwitch';
import { use, useEffect, useState } from 'react';

interface Brief {
  agency: string;
  publicNo: string;
  category: string;
  status: string;
  state: string;
  place: string;
  area: string | null;
  severity: string;
  reports: number;
  people: number;
  firstAt: string;
  lastAt: string;
  targetOn: string | null;
  fixNote: string | null;
  votes: { yes: number; no: number; needed: number };
  severities: { value: string; people: number }[];
  subtypes: { value: string; people: number }[];
  perDay: { day: string; reports: number }[];
  history: { label: string; note: string | null; at: string }[];
}

const LAGOS = { timeZone: 'Africa/Lagos' } as const;
const date = (d: string) => new Date(d).toLocaleDateString('en-GB', { ...LAGOS, day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = (d: string) => new Date(d).toLocaleString('en-GB', { ...LAGOS, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const SEVERITY: Record<string, string> = { small: 'Small', dangerous: 'Dangerous', blocking: 'Blocking the road or service' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function SharedIssue({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<{ share: { note: string; expiresAt: string }; brief: Brief } | null>(null);
  const [error, setError] = useState<{ title: string; line: string } | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/shared/issues/${encodeURIComponent(token)}`, { referrerPolicy: 'no-referrer' })
      .then(async (r) => {
        if (r.ok) return setData(await r.json());
        if (r.status === 410) return setError({ title: 'This link has expired.', line: 'Ask the agency that sent it for a new one.' });
        setError({ title: 'This link is not valid.', line: 'Check that you copied the whole link.' });
      })
      .catch(() => setError({ title: 'Could not load this brief.', line: 'Check your connection and try again.' }));
  }, [token]);

  if (error)
    return (
      <Frame>
        <div className="card empty" role="alert">
          <strong>{error.title}</strong>
          {error.line}
        </div>
      </Frame>
    );
  if (!data)
    return (
      <Frame>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 120 }} />
        ))}
      </Frame>
    );

  const { share, brief: b } = data;
  const max = Math.max(1, ...b.perDay.map((d) => d.reports));
  return (
    <Frame>
      <div className="page-head">
        <div>
          <span className="chip neutral">Shared by {b.agency}</span>
          <h1 style={{ margin: '8px 0 4px' }}>
            {b.category} · {b.publicNo}
          </h1>
          <p className="lede" style={{ margin: 0 }}>
            {b.place}
            {b.area ? ` · ${b.area}` : ''}
          </p>
        </div>
        <LinkButton className="btn primary" href={`${API_URL}/shared/issues/${encodeURIComponent(token)}/brief.pdf`}>
          Download PDF
        </LinkButton>
      </div>

      <div className="banner info" style={{ marginBottom: 16 }}>
        <strong>Note from {b.agency}</strong>
        {share.note}
      </div>

      <div className="stats">
        <div className="stat">
          <span>Status</span>
          <strong className={b.state === 'fixed' ? 'success' : b.state === 'reopened' ? 'critical' : undefined}>{b.status}</strong>
          <small>{b.targetOn ? `Target ${date(b.targetOn)}` : 'No target date yet'}</small>
        </div>
        <div className="stat">
          <span>People reported</span>
          <strong className={b.people >= 10 ? 'critical' : undefined}>{b.people}</strong>
          <small>{b.reports > b.people ? `${b.reports} reports, ` : ''}counted as one issue</small>
        </div>
        <div className="stat">
          <span>Worst reported</span>
          <strong className={b.severity === 'small' ? undefined : 'warning'}>{SEVERITY[b.severity] ?? b.severity}</strong>
          <small>
            First {date(b.firstAt)} · last {date(b.lastAt)}
          </small>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
        <section className="card" aria-labelledby="per-day">
          <h2 id="per-day">Reports per day</h2>
          <div className="bars" role="img" aria-label={b.perDay.map((d) => `${shortDay(d.day)}: ${d.reports}`).join(', ')}>
            {b.perDay.map((d) => (
              <i key={d.day} style={{ height: `${(d.reports / max) * 100}%` }} title={`${shortDay(d.day)}: ${plural(d.reports, 'report')}`} />
            ))}
          </div>
          <div className="bars-axis">
            <span>{b.perDay[0] ? shortDay(b.perDay[0].day) : ''}</span>
            <span>{b.perDay.length > 1 ? shortDay(b.perDay[b.perDay.length - 1]!.day) : ''}</span>
          </div>
        </section>

        <section className="card" aria-labelledby="say">
          <h2 id="say">What people report</h2>
          <dl className="facts">
            {[...b.subtypes, ...b.severities.map((s) => ({ ...s, value: SEVERITY[s.value] ?? s.value }))].map((s, i) => (
              <div key={`${s.value}-${i}`}>
                <dt>{s.value}</dt>
                <dd>{plural(s.people, 'person', 'people')}</dd>
              </div>
            ))}
            {b.state === 'awaiting_check' && (
              <div>
                <dt>Said it is fixed</dt>
                <dd>
                  {b.votes.yes} of {b.votes.needed}
                </dd>
              </div>
            )}
          </dl>
          {b.fixNote && <p className="quote">Agency note: {b.fixNote}</p>}
        </section>

        <section className="card" aria-labelledby="history">
          <h2 id="history">History</h2>
          <ol className="timeline">
            {b.history.map((e, i) => (
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

      <p className="muted" style={{ marginTop: 24 }}>
        View only. Reporters are not named. This link stops working on {date(share.expiresAt)}, and {b.agency} can turn it off sooner. Every view is logged.
      </p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  // A visitor has no account, so the choice stays on this device only.
  const [theme, setTheme] = useState<ThemeChoice>('system');
  useEffect(() => setTheme(readTheme()), []);
  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px 48px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <div className="brand-mark" aria-hidden>
          ERP
        </div>
        <strong style={{ flex: 1 }}>Emergency Response Platform</strong>
        <ThemeSwitch compact value={theme} onChange={(t) => (applyTheme(t), setTheme(t))} />
      </header>
      {children}
    </main>
  );
}
