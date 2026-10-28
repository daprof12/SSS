'use client';
// Board "Agency equipment inventory": vehicles, drones, fire drop kits and radios, by station. Each
// item is billed monthly; a check older than 30 days shows as due.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { shortDate, useToast, WithAgency, type MyAgency } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Item {
  id: string;
  name: string;
  station: string;
  count: number;
  status: 'ready' | 'in_use' | 'needs_service' | 'out_of_service';
  statusLabel: string;
  lastCheck: string | null;
  checkOverdue: boolean;
  pilot: string | null;
}
interface Inv {
  kinds: { code: string; label: string }[];
  stats: { vehiclesReady: number; dronesReady: number; dronePilots: number; fireKits: number; needsService: number };
  items: Item[];
}
const TONE: Record<Item['status'], string> = { ready: 'var(--color-success-text)', in_use: 'var(--color-info-text, var(--color-signal))', needs_service: 'var(--color-warning-text)', out_of_service: 'var(--color-emergency-text)' };

export default function AgencyInventoryPage() {
  return <WithAgency>{(a) => <Inventory key={a.id} agency={a} />}</WithAgency>;
}

function Inventory({ agency }: { agency: MyAgency }) {
  const [loc, setLoc] = useState<LocFilter>({});
  const [d, setD] = useState<Inv | null>(null);
  const [stations, setStations] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useToast();
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<Inv>(`/agencies/${agency.id}/equipment${lq ? `?${lq}` : ''}`)
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load equipment.'));
  }, [agency.id, lq]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ stations: { id: string; name: string }[] }>(`/agencies/${agency.id}/officers`)
      .then((x) => setStations(x.stations))
      .catch(() => setStations([]));
  }, [agency.id]);
  const patch = async (id: string, body: object) => {
    try {
      setToast((await api<{ message: string }>(`/agencies/${agency.id}/equipment/${id}`, { method: 'PATCH', body: JSON.stringify(body) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p className="lede">Vehicles, drones, fire drop kits and radios, by station.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" type="button" onClick={() => setAdding(true)}>
            Add item
          </button>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} title="Filter by station location" />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Vehicles ready</span>
          <strong className="success">{d?.stats.vehiclesReady ?? '—'}</strong>
          <small>Across all stations</small>
        </div>
        <div className="stat">
          <span>Drones ready</span>
          <strong className="info">{d?.stats.dronesReady ?? '—'}</strong>
          <small>{d ? `${d.stats.dronePilots} with a pilot named` : 'Pilot on duty'}</small>
        </div>
        <div className="stat">
          <span>Fire drop kits</span>
          <strong>{d?.stats.fireKits ?? '—'}</strong>
          <small>Loaded and checked</small>
        </div>
        <div className="stat">
          <span>Needs service</span>
          <strong className="warning">{d?.stats.needsService ?? '—'}</strong>
          <small>Or check overdue</small>
        </div>
      </div>
      <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="eq">
        <h2 id="eq" style={{ margin: 0, padding: '16px 16px 0' }}>
          Equipment
        </h2>
        {!d && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !d?.items.length ? (
          <div className="empty">No equipment yet. Add what your stations carry.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Station</th>
                <th>Count</th>
                <th>Last check</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.items.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.name}</strong>
                    {x.pilot && <div className="muted">Pilot: {x.pilot}</div>}
                  </td>
                  <td>{x.station}</td>
                  <td>{x.count}</td>
                  <td style={{ color: x.checkOverdue ? 'var(--color-warning-text)' : undefined }}>{x.lastCheck ? shortDate(x.lastCheck) : 'Never'}</td>
                  <td>
                    <select value={x.status} onChange={(e) => patch(x.id, { status: e.target.value })} aria-label={`Status of ${x.name}`} style={{ color: TONE[x.status], fontWeight: 600 }}>
                      <option value="ready">Ready</option>
                      <option value="in_use">In use</option>
                      <option value="needs_service">Needs service</option>
                      <option value="out_of_service">Out of service</option>
                    </select>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" type="button" onClick={() => patch(x.id, { checked: true })}>
                      Checked today
                    </button>{' '}
                    <button className="btn small" type="button" onClick={() => window.confirm(`Remove ${x.name}? Its fee stops from the next invoice.`) && patch(x.id, { remove: true })}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ margin: 0, padding: '8px 16px 16px' }}>
          Drones are flown by trained agency staff. The platform never flies them.
        </p>
      </section>
      {adding && d && <AddItem agencyId={agency.id} kinds={d.kinds} stations={stations} onClose={() => setAdding(false)} onDone={(m) => (setAdding(false), setToast(m), load())} />}
    </>
  );
}

function AddItem({ agencyId, kinds, stations, onClose, onDone }: { agencyId: string; kinds: { code: string; label: string }[]; stations: { id: string; name: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [kind, setKind] = useState(kinds[0]!.code);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [stationId, setStationId] = useState(stations[0]?.id ?? '');
  const [pilot, setPilot] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone(
        (await api<{ message: string }>(`/agencies/${agencyId}/equipment`, { method: 'POST', body: JSON.stringify({ kind, name: name.trim() || undefined, quantity: Number(qty), stationId: stationId || undefined, pilotName: pilot.trim() || undefined }) }))
          .message,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not add it.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Add item"
      description="Each item is billed monthly from the next invoice."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy || !qty}>
            Add
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
        <span>Type</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.code} value={k.code}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Name or model (optional)</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Drone, model A" />
      </label>
      <label className="field">
        <span>Count</span>
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label className="field">
        <span>Station</span>
        <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
          <option value="">Agency store</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {kind.endsWith('drone') && (
        <label className="field">
          <span>Trained pilot</span>
          <input type="text" value={pilot} onChange={(e) => setPilot(e.target.value)} maxLength={120} />
        </label>
      )}
    </Sheet>
  );
}
