'use client';
// "Statements" for the station and the agency: every statement on their reports, by who gave it
// (complainant, victim, witness, suspect, officer), where it stands, and the place of the report.
import { STATEMENT_ROLES } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { dateTime } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Item {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  role: string;
  form: string;
  mode: 'self' | 'in_person';
  maker: string;
  report: { id: string; label: string };
  station: string | null;
  versions: number;
  signedAt: string | null;
  at: string;
}
interface List {
  counts: { waiting: number; signed: number; inPerson: number; changeAsked: number };
  items: Item[];
}
const STATES: [string, string][] = [
  ['', 'All'],
  ['requested', 'Waiting for them'],
  ['draft', 'Being written'],
  ['change_requested', 'More detail asked'],
  ['signed', 'Signed'],
];

export function StatementsList({ path, showStation }: { path: string; showStation?: boolean }) {
  const [loc, setLoc] = useState<LocFilter>({});
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [d, setD] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = [status && `status=${status}`, role && `role=${role}`, q.trim() && `q=${encodeURIComponent(q.trim())}`, locQuery(loc)].filter(Boolean).join('&');
  useEffect(() => {
    const t = setTimeout(() => {
      api<List>(`${path}${query ? `?${query}` : ''}`)
        .then((x) => {
          setD(x);
          setError(null);
        })
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load statements.'));
    }, 250);
    return () => clearTimeout(t);
  }, [path, query]);
  return (
    <>
      <div className="stats">
        <div className="stat">
          <span>Waiting</span>
          <strong className="warning">{d?.counts.waiting ?? '—'}</strong>
          <small>Asked, not signed yet</small>
        </div>
        <div className="stat">
          <span>Signed</span>
          <strong className="success">{d?.counts.signed ?? '—'}</strong>
          <small>Sealed, no one can edit</small>
        </div>
        <div className="stat">
          <span>Taken in person</span>
          <strong className="info">{d?.counts.inPerson ?? '—'}</strong>
          <small>Confirmed with a phone code</small>
        </div>
        <div className="stat">
          <span>More detail asked</span>
          <strong>{d?.counts.changeAsked ?? '—'}</strong>
          <small>A new version is coming</small>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} title="Filter by place of the report" />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 12px' }}>
        <div className="segmented" role="group" aria-label="Status">
          {STATES.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>
              {l}
            </button>
          ))}
        </div>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Who gave it">
          <option value="">Everyone</option>
          {STATEMENT_ROLES.map((r) => (
            <option key={r.code} value={r.code}>
              {r.form}
            </option>
          ))}
        </select>
        <input className="search" type="search" placeholder="Search a number, name or postcode" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search statements" style={{ minWidth: 260 }} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!d && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !d?.items.length ? (
          <div className="empty">No statements match. Ask for one from any report.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Statement</th>
                <th>Given by</th>
                <th>Report</th>
                {showStation && <th>Station</th>}
                <th>How</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/statements/${s.id}`}>
                      <strong>{s.number}</strong>
                    </Link>
                    <div className="muted">{s.form}</div>
                  </td>
                  <td>{s.maker}</td>
                  <td>
                    <Link href={`/incidents/${s.report.id}`}>{s.report.label}</Link>
                  </td>
                  {showStation && <td>{s.station ?? '—'}</td>}
                  <td>{s.mode === 'in_person' ? 'In person' : 'On their phone'}</td>
                  <td>
                    <strong style={{ color: s.state === 'signed' ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>
                      {s.state === 'signed' ? `Signed, v${s.versions}` : s.stateLabel === 'Waiting for you' ? 'Waiting for them' : s.stateLabel}
                    </strong>
                  </td>
                  <td>{dateTime(s.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
