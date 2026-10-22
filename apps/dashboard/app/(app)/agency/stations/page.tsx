'use client';
// Board "Agency stations": every station, its head, who is on duty and how it is rated.
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WithAgency, type MyAgency } from '@/components/Agency';

interface St {
  id: string;
  name: string;
  status: string;
  postcode: string | null;
  head: string | null;
  officers: number;
  onDuty: number;
  open: number;
  rating: number | null;
  reportsMonth: number;
}
const STATUS: Record<string, [string, string]> = { active: ['Active', 'success'], draft: ['Draft', 'neutral'], invite_sent: ['Head invited', 'warning'], paused: ['Paused', 'neutral'] };

export default function AgencyStationsPage() {
  return <WithAgency>{(a) => <Stations key={a.id} agency={a} />}</WithAgency>;
}

function Stations({ agency }: { agency: MyAgency }) {
  const [list, setList] = useState<St[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<St[]>(`/agencies/${agency.id}/station-list`)
      .then(setList)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load stations.'));
  }, [agency.id]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stations</h1>
          <p className="lede">Every station in {agency.name}, who leads it and who is on duty.</p>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!list && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !list?.length ? (
          <div className="empty">
            <strong>No stations yet.</strong>
            Add your first station to start receiving reports.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Station</th>
                <th>Head</th>
                <th>Officers</th>
                <th>On duty</th>
                <th>Open now</th>
                <th>Reports, 30 days</th>
                <th>Rating</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/agency/stations/${s.id}`}>
                      <strong>{s.name}</strong>
                    </Link>
                    <div className="muted">{s.postcode ?? 'No building yet'}</div>
                  </td>
                  <td>{s.head ?? '—'}</td>
                  <td>{s.officers}</td>
                  <td style={{ color: s.status === 'active' && !s.onDuty ? 'var(--color-emergency-text)' : undefined, fontWeight: 700 }}>{s.onDuty}</td>
                  <td>{s.open}</td>
                  <td>{s.reportsMonth}</td>
                  <td>
                    <Rating value={s.rating} empty="—" />
                  </td>
                  <td>
                    <span className={`chip ${STATUS[s.status]?.[1] ?? 'neutral'}`}>{STATUS[s.status]?.[0] ?? s.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted">A station with nobody on duty passes its reports to the next station until someone is on duty.</p>
    </>
  );
}
