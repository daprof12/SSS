'use client';
// Board "Station detail" (agency): who is on duty, live reports, the area the station covers, its
// equipment and the devices watching nearby. Edit the station or add an officer from here.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, useToast, WithAgency, type MyAgency } from '@/components/Agency';
import { mmss, STATE_LABEL, ZoneMap } from '@/components/Dash';

interface Detail {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  postcode: string | null;
  address: string | null;
  area: string | null;
  lga: string | null;
  center: { lat: number; lng: number } | null;
  stats: { onDuty: number; officers: number; open: number; avgResponseS: number | null; rating: number | null };
  officers: { id: string; name: string; line: string; status: 'on_duty' | 'off_duty' | 'busy' | 'invited' }[];
  live: { id: string; label: string; state: string; line: string; offerSecondsLeft: number | null }[];
  areas: { level: string; id: string; label: string }[];
  equipment: { id: string; name: string; count: number; status: string; statusLabel: string; pilot: string | null }[];
  devices: { cameras: { total: number; online: number; faults: number }; lights: { total: number; online: number; lowPower: number }; tamper24h: number };
  reports: { id: string; label: string; state: string; at: string; closedAt: string | null }[];
}
const OFF: Record<string, [string, string]> = {
  on_duty: ['On duty', 'var(--color-success-text)'],
  busy: ['Busy', 'var(--color-warning-text)'],
  off_duty: ['Off duty', 'var(--color-text-secondary)'],
  invited: ['Invited', 'var(--color-warning-text)'],
};
type Tab = 'overview' | 'officers' | 'equipment' | 'coverage' | 'reports';

export default function StationDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <WithAgency>{(a) => <StationDetail key={a.id} agency={a} id={id} />}</WithAgency>;
}

function StationDetail({ agency, id }: { agency: MyAgency; id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Detail>(`/agencies/${agency.id}/stations/${id}/detail`)
      .then(setD)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the station.'));
  }, [agency.id, id]);
  useEffect(load, [load]);
  if (error) {
    return (
      <div className="card empty">
        <strong>{error}</strong>
        <Link href="/agency/stations">Back to stations</Link>
      </div>
    );
  }
  if (!d) return <div className="skeleton" style={{ height: 300 }} />;
  const show = (t: Tab) => tab === 'overview' || tab === t;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>{d.name}</h1>
          <p className="lede">{[d.postcode && `Postcode ${d.postcode}`, d.address, d.area, d.lga].filter(Boolean).join(', ') || 'No building set yet'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={() => setEditing(true)}>
            Edit station
          </button>
          <Link className="btn primary" href="/agency/officers#add">
            Add officer
          </Link>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {(['overview', 'officers', 'equipment', 'coverage', 'reports'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'overview' && (
        <div className="stats">
          <div className="stat">
            <span>On duty</span>
            <strong className="success">{d.stats.onDuty}</strong>
            <small>Of {d.stats.officers} officers</small>
          </div>
          <div className="stat">
            <span>Open reports</span>
            <strong className="critical">{d.stats.open}</strong>
            <small>Right now</small>
          </div>
          <div className="stat">
            <span>Average response</span>
            <strong className="info">{mmss(d.stats.avgResponseS)}</strong>
            <small>This month</small>
          </div>
          <div className="stat">
            <span>Station rating</span>
            <strong>{d.stats.rating ?? '—'}</strong>
            <small>From citizens</small>
          </div>
        </div>
      )}
      <div className="grid two">
        {show('officers') && (
          <section className="card" aria-labelledby="od">
            <h2 id="od" style={{ marginTop: 0 }}>
              {tab === 'officers' ? 'Officers' : 'Officers on duty'}
            </h2>
            {!d.officers.length && <p className="muted">No officers yet.</p>}
            {(tab === 'officers' ? d.officers : d.officers.slice(0, 6)).map((o) => (
              <div className="row" key={o.id}>
                <div className="label">
                  <strong>{o.name}</strong>
                  <span>{o.line}</span>
                </div>
                <strong style={{ color: OFF[o.status]![1] }}>{OFF[o.status]![0]}</strong>
              </div>
            ))}
          </section>
        )}
        {tab === 'overview' && (
          <section className="card" aria-labelledby="lr">
            <h2 id="lr" style={{ marginTop: 0 }}>
              Live reports at this station
            </h2>
            {!d.live.length && <p className="muted">Nothing open right now.</p>}
            {d.live.map((i) => (
              <Link key={i.id} className="row" href={`/incidents/${i.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <div className="label">
                  <strong>{i.label}</strong>
                  <span>
                    {i.line}
                    {i.offerSecondsLeft != null ? `, ${i.offerSecondsLeft}s left` : ''}
                  </span>
                </div>
                <strong>{STATE_LABEL[i.state] ?? i.state}</strong>
              </Link>
            ))}
          </section>
        )}
      </div>
      {show('coverage') && (
        <section className="card" aria-labelledby="cov">
          <h2 id="cov" style={{ marginTop: 0 }}>
            Area this station covers
          </h2>
          {d.center ? <ZoneMap center={d.center} radiusM={2500} height={300} /> : <p className="muted">Set the station&apos;s building to see it on the map.</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 4px' }}>
            {!d.areas.length && <span className="chip warning">No area set. Reports reach it only as the nearest station.</span>}
            {d.areas.map((a) => (
              <span key={`${a.level}:${a.id}`} className="chip info">
                {a.label}
              </span>
            ))}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Areas come from the postcode service. Buildings inside them are offered to this station first. The station head changes them in Station settings.
          </p>
        </section>
      )}
      <div className="grid two">
        {show('equipment') && (
          <section className="card" aria-labelledby="eq">
            <h2 id="eq" style={{ marginTop: 0 }}>
              Equipment here
            </h2>
            {!d.equipment.length && <p className="muted">No equipment listed. Add it in Inventory.</p>}
            {d.equipment.map((e) => (
              <div className="row" key={e.id}>
                <div className="label">
                  <strong>{e.name}</strong>
                  <span>{e.pilot ? `Pilot: ${e.pilot}` : `${e.count} ${e.status === 'ready' ? 'ready' : ''}`}</span>
                </div>
                <strong style={{ color: e.status === 'ready' ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{e.statusLabel}</strong>
              </div>
            ))}
          </section>
        )}
        {(tab === 'overview' || tab === 'coverage') && (
          <section className="card" aria-labelledby="dv">
            <h2 id="dv" style={{ marginTop: 0 }}>
              Devices watching nearby
            </h2>
            <div className="row">
              <div className="label">
                <strong>Cameras within the area</strong>
                <span>
                  {d.devices.cameras.online} online, {d.devices.cameras.faults} with a fault
                </span>
              </div>
              <strong>{d.devices.cameras.total}</strong>
            </div>
            <div className="row">
              <div className="label">
                <strong>Street lights within the area</strong>
                <span>
                  {d.devices.lights.online} online, {d.devices.lights.lowPower} low power
                </span>
              </div>
              <strong>{d.devices.lights.total}</strong>
            </div>
            <div className="row">
              <div className="label">
                <strong>Tamper alerts</strong>
                <span>Last 24 hours</span>
              </div>
              <strong style={{ color: d.devices.tamper24h ? 'var(--color-emergency-text)' : undefined }}>{d.devices.tamper24h}</strong>
            </div>
          </section>
        )}
      </div>
      {tab === 'reports' && (
        <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {!d.reports.length ? (
            <div className="empty">No reports yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Status</th>
                  <th>Received</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {d.reports.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/incidents/${r.id}`}>{r.label}</Link>
                    </td>
                    <td>{STATE_LABEL[r.state] ?? r.state}</td>
                    <td>{dateTime(r.at)}</td>
                    <td>{r.closedAt ? dateTime(r.closedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {editing && <EditStation agencyId={agency.id} d={d} onClose={() => setEditing(false)} onDone={(m) => (setEditing(false), setToast(m), load())} />}
    </>
  );
}

function EditStation({ agencyId, d, onClose, onDone }: { agencyId: string; d: Detail; onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState(d.name);
  const [phone, setPhone] = useState(d.phone ?? '');
  const [status, setStatus] = useState(d.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(
        (
          await api<{ message: string }>(`/agencies/${agencyId}/stations/${d.id}/profile`, {
            method: 'PATCH',
            body: JSON.stringify({ name, phone: phone || undefined, status: status === 'active' || status === 'paused' ? status : undefined }),
          })
        ).message,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Edit station"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy || name.trim().length < 2}>
            Save
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      <label className="field">
        <span>Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label className="field">
        <span>Phone</span>
        <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+234" />
      </label>
      {(d.status === 'active' || d.status === 'paused') && (
        <label className="field">
          <span>Receiving reports</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Yes, active</option>
            <option value="paused">Paused (reports go to other stations)</option>
          </select>
        </label>
      )}
    </Sheet>
  );
}
