'use client';

import { issueCategories } from '@erp/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { WithAgency, dateOnly, daysSince, plural, shortDate, type MyAgency } from '@/components/Agency';
import { IssueStateChip, SeverityChip, isOverdue } from '@/components/IssueChips';
import { DateRange, useDateRange } from '@/components/DateRange';

export interface IssueRow {
  id: string;
  public_no: string;
  category: string;
  state: string;
  severity: string;
  report_count: number;
  people_count: number;
  first_at: string;
  last_at: string;
  target_on: string | null;
  postcode: string | null;
  area_label: string | null;
}

const STATES = [
  ['', 'Any state'],
  ['open', 'Open'],
  ['assigned', 'Taken on'],
  ['in_progress', 'Work started'],
  ['awaiting_check', 'Waiting for reporters'],
  ['reopened', 'Reopened'],
  ['fixed', 'Fixed'],
] as const;

/** Public issues for the agency (board "Agency public issues"): sorted by report count. */
export default function IssuesPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Public issues</h1>
          <p className="lede">Problems citizens reported in your area, most reported first.</p>
        </div>
      </div>
      <WithAgency needs="issues">{(a) => <Issues key={a.id} agency={a} />}</WithAgency>
    </>
  );
}

function Issues({ agency }: { agency: MyAgency }) {
  const router = useRouter();
  const [rows, setRows] = useState<IssueRow[] | null>(null);
  const dates = useDateRange('all');
  const [error, setError] = useState<ApiError | null>(null);
  const [cat, setCat] = useState('');
  const [area, setArea] = useState('');
  const [state, setState] = useState('');
  const [postcode, setPostcode] = useState('');

  useEffect(() => {
    api<IssueRow[]>(`/agencies/${agency.id}/issues${dates.q ? `?${dates.q}` : ''}`)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch(setError);
  }, [agency.id, dates.q]);

  const today = dateOnly(new Date());
  const areas = useMemo(() => [...new Set((rows ?? []).map((r) => r.area_label).filter(Boolean))].sort() as string[], [rows]);
  const cats = useMemo(() => issueCategories.filter((c) => rows?.some((r) => r.category === c.label)), [rows]);
  const shown = (rows ?? []).filter(
    (r) =>
      (!cat || r.category === cat) &&
      (!area || r.area_label === area) &&
      (!state || r.state === state) &&
      (!postcode.trim() || (r.postcode ?? '').toLowerCase().includes(postcode.trim().toLowerCase().replace(/\s/g, ''))),
  );
  const overdue = (rows ?? []).filter((r) => isOverdue(r, today)).length;
  const filtered = !!(cat || area || state || postcode.trim());

  return (
    <>
      {error && (
        <div className={`banner ${error.status === 0 ? 'warning' : 'critical'}`} role="alert">
          <strong>{error.status === 0 ? 'You are offline.' : 'Could not load public issues'}</strong>
          {error.status === 0 ? 'Check your connection and reload.' : error.message}
        </div>
      )}

      {cats.length > 1 && (
        <div className="chips" role="group" aria-label="Category" style={{ marginBottom: 16 }}>
          <button type="button" aria-pressed={!cat} onClick={() => setCat('')}>
            All
          </button>
          {cats.map((c) => (
            <button key={c.code} type="button" aria-pressed={cat === c.label} onClick={() => setCat(c.label)}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} />
      </div>
      <div className="card filters" role="search" aria-label="Filter by location">
        <label className="field">
          <span>Area</span>
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All areas</option>
            {areas.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>State of the work</span>
          <select value={state} onChange={(e) => setState(e.target.value)}>
            {STATES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Postcode</span>
          <input type="search" placeholder="Search a postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
        </label>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {rows === null && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="empty">
            <strong>{filtered ? 'No issues match these filters.' : 'No public issues yet.'}</strong>
            {filtered ? 'Clear a filter to see more.' : 'Reports citizens send to your agency appear here.'}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Reports</th>
                <th>Severity</th>
                <th>State</th>
                <th>Fix by</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="link" onClick={() => router.push(`/agency/issues/${r.id}`)}>
                  <td>
                    <Link href={`/agency/issues/${r.id}`} style={{ color: 'inherit', fontWeight: 700, textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                      {r.category}
                    </Link>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                      {[r.postcode ?? 'GPS only', r.area_label].filter(Boolean).join(', ')} · {r.public_no}
                    </div>
                  </td>
                  <td>
                    <strong>{r.report_count}</strong>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{plural(r.people_count, 'person', 'people')}</div>
                  </td>
                  <td>
                    <SeverityChip severity={r.severity} />
                  </td>
                  <td>
                    <IssueStateChip state={r.state} />
                  </td>
                  <td>
                    {r.target_on ? shortDate(r.target_on) : '—'}
                    {isOverdue(r, today) && <div style={{ color: 'var(--color-emergency-text)', fontSize: 12, fontWeight: 600 }}>Past target</div>}
                  </td>
                  <td>{daysSince(r.first_at) === 0 ? 'Today' : plural(daysSince(r.first_at), 'day')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {overdue > 0 && (
        <div className="banner warning" style={{ marginTop: 16 }}>
          <strong>{overdue === 1 ? '1 issue has passed its fix date' : `${overdue} issues have passed their fix date`}</strong>
          Set a new date or mark them fixed when the work is done.
        </div>
      )}
    </>
  );
}
