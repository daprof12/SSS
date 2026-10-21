'use client';
// Board "Admin users": citizens, owners, officers, heads, technicians and staff. Search by name,
// phone or postcode. Adding staff is done from the agency (officers) or Settings (staff roles).
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';

interface U {
  id: string;
  name: string;
  phone: string | null;
  role: string;
  postcode: string | null;
  kyc: string;
  status: string;
  joined: string;
}
type R = 'all' | 'citizens' | 'owners' | 'officers' | 'heads' | 'technicians' | 'staff';
const KYC: Record<string, [string, string]> = {
  verified: ['Verified', 'var(--color-success-text)'],
  manual_review: ['Review', 'var(--color-warning-text)'],
  pending: ['Pending', 'var(--color-warning-text)'],
  failed: ['Failed', 'var(--color-emergency-text)'],
  badge_check: ['Badge check', 'var(--color-warning-text)'],
  not_started: ['Not started', 'var(--color-text-secondary)'],
};

export default function Users() {
  const [role, setRole] = useState<R>('all');
  const [q, setQ] = useState('');
  const [list, setList] = useState<U[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<U[]>(`/admin/users?role=${role}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
        .then(setList)
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load users.'));
    }, 250);
    return () => clearTimeout(t);
  }, [role, q]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="lede">Citizens, household owners, officers, station heads, agency and platform staff.</p>
        </div>
        <input className="search" type="search" placeholder="Search a name, phone or postcode" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" style={{ minWidth: 280 }} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="segmented tabs" role="tablist">
        {(['all', 'citizens', 'owners', 'officers', 'heads', 'technicians', 'staff'] as R[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={role === k} aria-pressed={role === k} onClick={() => setRole(k)}>
            {k[0]!.toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!list && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !list?.length ? (
          <div className="empty">No one matches.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Postcode</th>
                <th>KYC</th>
                <th>Status</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    <div className="muted">{u.phone}</div>
                  </td>
                  <td>{u.role}</td>
                  <td>{u.postcode ?? '—'}</td>
                  <td>
                    <strong style={{ color: KYC[u.kyc]?.[1] }}>{KYC[u.kyc]?.[0] ?? u.kyc}</strong>
                  </td>
                  <td>
                    <strong style={{ color: u.status === 'active' ? 'var(--color-success-text)' : 'var(--color-emergency-text)' }}>{u.status[0]!.toUpperCase() + u.status.slice(1)}</strong>
                  </td>
                  <td>{new Date(u.joined).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
