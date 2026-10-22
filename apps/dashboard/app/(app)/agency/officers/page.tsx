'use client';
// Board "Agency officers and add user": officers and station heads, their ratings and rewards, and an
// invite that the person completes by verifying their identity.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast, WithAgency, type MyAgency } from '@/components/Agency';
import { naira } from '@/components/Dash';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Officer {
  id: string;
  name: string;
  badgeNo: string;
  station: string;
  role: string;
  rating: number | null;
  rewardsKobo: number;
  status: 'on_duty' | 'off_duty' | 'busy' | 'invited';
}

export default function AgencyOfficersPage() {
  return <WithAgency>{(a) => <Officers key={a.id} agency={a} />}</WithAgency>;
}

function Officers({ agency }: { agency: MyAgency }) {
  const [loc, setLoc] = useState<LocFilter>({});
  const [d, setD] = useState<{ stations: { id: string; name: string }[]; items: Officer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<typeof d>(`/agencies/${agency.id}/officers${lq ? `?${lq}` : ''}`)
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load officers.'));
  }, [agency.id, lq]);
  useEffect(load, [load]);
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Officers</h1>
          <p className="lede">Officers and station heads in {agency.name}, with their ratings and rewards.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <LinkButton className="btn primary" href="#add">
            Add officer
          </LinkButton>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} title="Filter by station location" />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)' }}>
        <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {!d && !error ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" />
            </div>
          ) : !d?.items.length ? (
            <div className="empty">No officers here yet. Invite one with the form.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Station</th>
                  <th>Rating</th>
                  <th>Rewards</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={o.name} size={36} status={o.status} />
                        <span>
                          <strong>{o.name}</strong>
                          <div className="muted">
                            {o.role}, {o.badgeNo}
                          </div>
                        </span>
                      </span>
                    </td>
                    <td>{o.station}</td>
                    <td>
                      <Rating value={o.rating} empty="New" />
                    </td>
                    <td>{naira(o.rewardsKobo)}</td>

                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {d && <AddOfficer agencyId={agency.id} stations={d.stations} onDone={(m) => (setToast(m), load())} />}
      </div>
    </>
  );
}

function AddOfficer({ agencyId, stations, onDone }: { agencyId: string; stations: { id: string; name: string }[]; onDone: (m: string) => void }) {
  const blank = { name: '', serviceNo: '', phone: '+234', stationId: stations[0]?.id ?? '', role: 'officer' as 'officer' | 'head' };
  const [f, setF] = useState(blank);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    setFields({});
    try {
      onDone((await api<{ message: string }>(`/agencies/${agencyId}/officers/invite`, { method: 'POST', body: JSON.stringify({ ...f, phone: f.phone.replace(/\s+/g, '') }) })).message);
      setF(blank);
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message);
        setFields(Object.fromEntries((e.fields ?? []).map((x) => [x.field, x.message])));
      } else setErr('Could not send the invite.');
    } finally {
      setBusy(false);
    }
  };
  const input = (k: 'name' | 'serviceNo' | 'phone', label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field" data-invalid={!!fields[k]}>
      <span>{label}</span>
      <input type="text" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} />
      {fields[k] && <span className="field-error">{fields[k]}</span>}
    </label>
  );
  return (
    <section className="card" id="add" aria-labelledby="addh">
      <h2 id="addh" style={{ marginTop: 0 }}>
        Add officer
      </h2>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '0 0 8px' }}>
          {err}
        </div>
      )}
      {input('name', 'Full name', { maxLength: 120 })}
      {input('serviceNo', 'Service number', { maxLength: 40 })}
      {input('phone', 'Phone', { inputMode: 'tel' })}
      <label className="field" data-invalid={!!fields.stationId}>
        <span>Station</span>
        <select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Role</span>
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'officer' | 'head' })}>
          <option value="officer">Officer</option>
          <option value="head">Station head</option>
        </select>
      </label>
      <p className="muted">The officer gets an invite and must pass identity verification before receiving reports.</p>
      <button className="btn signal" type="button" style={{ width: '100%' }} onClick={submit} disabled={busy || !f.stationId}>
        {busy ? 'Sending…' : 'Send invite'}
      </button>
    </section>
  );
}
