'use client';
// Every kind of report on the overviews: emergencies, tips and public issues. Open now, received in
// the chosen dates, per day, and the latest open ones.
import Link from 'next/link';
import { ago, STATE_LABEL } from './Dash';
import { KIND } from './LiveReports';

type Kind = 'emergency' | 'tip' | 'issue';
export interface Mix {
  kinds: Kind[];
  range: { from: string; to: string; by: 'day' | 'month' };
  open: Partial<Record<Kind, number>>;
  received: Partial<Record<Kind, number>>;
  series: ({ label: string } & Record<Kind, number>)[];
  latest: { id: string; kind: Kind; label: string; state: string; line: string; at: string; href: string }[];
}
const NAME: Record<Kind, [string, string]> = {
  emergency: ['Open emergencies', 'emergencies'],
  tip: ['Open tips', 'tips'],
  issue: ['Open public issues', 'public issues'],
};
const TIP_STATE: Record<string, string> = { sent: 'New', in_queue: 'In queue', more_info: 'More info asked', claim_review: 'Claim review' };
const ISSUE_STATE: Record<string, string> = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress', awaiting_check: 'Awaiting check', reopened: 'Reopened' };
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The three stat cards: open now, and how many came in over the dates chosen. */
export function MixStats({ m }: { m: Mix | null | undefined }) {
  const kinds = m?.kinds ?? (['emergency', 'tip', 'issue'] as Kind[]);
  return (
    <>
      {kinds.map((k) => (
        <div className="stat" key={k}>
          <span>{NAME[k][0]}</span>
          <strong style={{ color: KIND[k].color }}>{m?.open[k] ?? '—'}</strong>
          <small>{m ? `${m.received[k] ?? 0} received in these dates` : ' '}</small>
        </div>
      ))}
    </>
  );
}

/** Reports by day (or month), one coloured segment per kind. */
export function MixChart({ m }: { m: Mix }) {
  const max = Math.max(1, ...m.series.map((s) => m.kinds.reduce((a, k) => a + s[k], 0)));
  return (
    <>
      <div className="stack-legend">
        {m.kinds.map((k) => (
          <span key={k}>
            <i style={{ background: KIND[k].color }} />
            {KIND[k].label}: {m.received[k] ?? 0}
          </span>
        ))}
      </div>
      <div className="stack-bars">
        {m.series.map((s) => {
          const total = m.kinds.reduce((a, k) => a + s[k], 0);
          return (
            <div className="stack-bar" key={s.label} title={m.kinds.map((k) => `${s[k]} ${NAME[k][1]}`).join(', ')}>
              <span>{s.label}</span>
              <span className="track" aria-hidden>
                {m.kinds.map((k) => (s[k] ? <i key={k} style={{ width: `${(s[k] / max) * 100}%`, background: KIND[k].color }} /> : null))}
              </span>
              <strong>{total}</strong>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ margin: '10px 0 0', fontSize: 'var(--text-sm)' }}>
        {day(m.range.from)} to {day(m.range.to)}, {m.range.by === 'month' ? 'by month' : 'by day'}.
      </p>
    </>
  );
}

/** The latest open reports of every kind, each linking to its own page. */
export function MixLatest({ m }: { m: Mix }) {
  if (!m.latest.length) return <p className="muted">No open reports right now.</p>;
  return (
    <>
      {m.latest.map((x) => (
        <Link key={`${x.kind}-${x.id}`} className="row" href={x.href} style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="label">
            <strong>
              <span style={{ color: KIND[x.kind].color }} aria-hidden>
                ●{' '}
              </span>
              {x.label}
            </strong>
            <span>
              {x.line}, {ago(x.at)} ago
            </span>
          </div>
          <span className="chip neutral">{x.kind === 'emergency' ? (STATE_LABEL[x.state] ?? x.state) : x.kind === 'tip' ? (TIP_STATE[x.state] ?? x.state) : (ISSUE_STATE[x.state] ?? x.state)}</span>
        </Link>
      ))}
    </>
  );
}
