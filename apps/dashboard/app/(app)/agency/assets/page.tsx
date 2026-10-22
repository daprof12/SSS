'use client';
// Board "Agency infrastructure assets": traffic lights, street lights and cameras the agency is in
// charge of, with faults, citizen reports nearby and service dates.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { shortDate, useToast, WithAgency, type MyAgency } from '@/components/Agency';
import { ago } from '@/components/Dash';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Asset {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  area: string;
  status: string;
  statusLabel: string;
  lastSignal: string | null;
  nextService: string | null;
  serviceOverdue: boolean;
  citizenReports: number;
}
interface Board {
  stats: { total: number; traffic: number; street: number; camera: number; onlinePct: number; openFaults: number; citizenReported: number; overdue: number };
  items: Asset[];
}
const TONE: Record<string, string> = { online: 'var(--color-success-text)', low_power: 'var(--color-warning-text)', offline: 'var(--color-text-secondary)', fault: 'var(--color-emergency-text)' };
const TABS: [string, string][] = [
  ['all', 'All'],
  ['traffic_light', 'Traffic lights'],
  ['street_light', 'Street lights'],
  ['camera', 'Cameras'],
  ['faults', 'Faults'],
  ['overdue', 'Overdue service'],
];

export default function AgencyAssetsPage() {
  return <WithAgency>{(a) => <Assets key={a.id} agency={a} />}</WithAgency>;
}

function Assets({ agency }: { agency: MyAgency }) {
  const [loc, setLoc] = useState<LocFilter>({});
  const [tab, setTab] = useState('all');
  const [d, setD] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'add' | 'import' | 'order' | null>(null);
  const [toast, setToast] = useToast();
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<Board>(`/agencies/${agency.id}/assets?tab=${tab}${lq ? `&${lq}` : ''}`)
      .then((x) => {
        setD(x);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load assets.'));
  }, [agency.id, tab, lq]);
  useEffect(load, [load]);
  const s = d?.stats;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Infrastructure assets</h1>
          <p className="lede">Traffic lights, street lights and cameras you are in charge of.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={() => setSheet('add')}>
            Add asset
          </button>
          <button className="btn" type="button" onClick={() => setSheet('import')}>
            Import list
          </button>
          <button className="btn signal" type="button" disabled={!d?.items.length} onClick={() => setSheet('order')}>
            New work order
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Assets</span>
          <strong>{s?.total ?? '—'}</strong>
          <small>{s ? `${s.traffic} traffic, ${s.street} street, ${s.camera} camera` : ''}</small>
        </div>
        <div className="stat">
          <span>Online</span>
          <strong className="success">{s ? `${s.onlinePct}%` : '—'}</strong>
          <small>Last 24 hours</small>
        </div>
        <div className="stat">
          <span>Open faults</span>
          <strong className="critical">{s?.openFaults ?? '—'}</strong>
          <small>{s ? `${s.citizenReported} reported by citizens` : ''}</small>
        </div>
        <div className="stat">
          <span>Service overdue</span>
          <strong className="warning">{s?.overdue ?? '—'}</strong>
          <small>Past schedule</small>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!d && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !d?.items.length ? (
          <div className="empty">No assets here. Add one, or import a list.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Type</th>
                <th>Area</th>
                <th>Status</th>
                <th>Last signal</th>
                <th>Next service</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/agency/assets/${a.id}`}>
                      <strong>{a.name}</strong>
                    </Link>
                    {a.citizenReports > 0 && <div className="muted">{a.citizenReports} citizen reports this week</div>}
                  </td>
                  <td>{a.kindLabel}</td>
                  <td>{a.area || '—'}</td>
                  <td>
                    <strong style={{ color: TONE[a.status] }}>{a.statusLabel}</strong>
                  </td>
                  <td>{a.lastSignal ? ago(a.lastSignal) : 'Never'}</td>
                  <td style={{ color: a.serviceOverdue ? 'var(--color-warning-text)' : undefined }}>{a.serviceOverdue ? 'Overdue' : a.nextService ? shortDate(a.nextService) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <div className="banner warning">
        <strong style={{ display: 'block' }}>Traffic lights are monitor-only at first</strong>
        Reading status needs the controller to share it. Changing signals needs the agency to approve a safety plan.
      </div>
      <div className="banner info">
        <strong style={{ display: 'block' }}>Public reports are linked</strong>A citizen report near an asset adds to its report count, so you can open a work order.
      </div>
      {sheet === 'add' && <AddAsset agencyId={agency.id} onClose={() => setSheet(null)} onDone={(m) => (setSheet(null), setToast(m), load())} />}
      {sheet === 'import' && <ImportAssets agencyId={agency.id} onClose={() => setSheet(null)} onDone={(m) => (setSheet(null), setToast(m), load())} />}
      {sheet === 'order' && d && <WorkOrder agencyId={agency.id} assets={d.items} onClose={() => setSheet(null)} onDone={(m) => (setSheet(null), setToast(m))} />}
    </>
  );
}

function Foot({ busy, onClose, onSubmit, label, disabled }: { busy: boolean; onClose: () => void; onSubmit: () => void; label: string; disabled?: boolean }) {
  return (
    <>
      <button className="btn" type="button" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button className="btn primary" type="button" onClick={onSubmit} disabled={busy || disabled}>
        {label}
      </button>
    </>
  );
}

function AddAsset({ agencyId, onClose, onDone }: { agencyId: string; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ kind: 'traffic_light', name: '', postcode: '', controller: '', nextServiceOn: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone((await api<{ message: string }>(`/agencies/${agencyId}/assets`, { method: 'POST', body: JSON.stringify({ ...f, postcode: f.postcode || undefined, controller: f.controller || undefined, nextServiceOn: f.nextServiceOn || undefined }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not add it.');
      setBusy(false);
    }
  };
  return (
    <Sheet open title="Add asset" onClose={onClose} busy={busy} footer={<Foot busy={busy} onClose={onClose} onSubmit={submit} label="Add" disabled={f.name.trim().length < 2} />}>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      <label className="field">
        <span>Type</span>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="traffic_light">Traffic light</option>
          <option value="street_light">Street light</option>
          <option value="camera">Camera</option>
        </select>
      </label>
      <label className="field">
        <span>Name</span>
        <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} placeholder="Junction 12, Ring Rd" />
      </label>
      <label className="field">
        <span>Postcode of the nearest building</span>
        <input type="text" value={f.postcode} onChange={(e) => setF({ ...f, postcode: e.target.value.toUpperCase() })} maxLength={12} />
      </label>
      <label className="field">
        <span>Controller model (optional)</span>
        <input type="text" value={f.controller} onChange={(e) => setF({ ...f, controller: e.target.value })} maxLength={80} />
      </label>
      <label className="field">
        <span>Next service</span>
        <input type="date" value={f.nextServiceOn} onChange={(e) => setF({ ...f, nextServiceOn: e.target.value })} />
      </label>
    </Sheet>
  );
}

function ImportAssets({ agencyId, onClose, onDone }: { agencyId: string; onClose: () => void; onDone: (m: string) => void }) {
  const [csv, setCsv] = useState('kind, name, postcode\n');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ added: number; failed: { line: number; reason: string }[]; message: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<typeof res>(`/agencies/${agencyId}/assets/import`, { method: 'POST', body: JSON.stringify({ csv }) });
      if (r && !r.failed.length) onDone(r.message);
      else setRes(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not import.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open title="Import list" description="One asset per line: kind, name, postcode. Kind is traffic light, street light or camera." onClose={() => (res ? onDone(res.message) : onClose())} busy={busy} footer={<Foot busy={busy} onClose={() => (res ? onDone(res.message) : onClose())} onSubmit={submit} label="Import" />}>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      <textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace' }} aria-label="Asset list" />
      {res && (
        <div className="banner warning" style={{ margin: 0 }}>
          <strong style={{ display: 'block' }}>{res.message}</strong>
          {res.failed.map((f) => (
            <div key={f.line}>
              Line {f.line}: {f.reason}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function WorkOrder({ agencyId, assets, onClose, onDone }: { agencyId: string; assets: Asset[]; onClose: () => void; onDone: (m: string) => void }) {
  const [assetId, setAssetId] = useState(assets.find((a) => a.status === 'fault')?.id ?? assets[0]!.id);
  const [kind, setKind] = useState('repair');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      onDone((await api<{ message: string }>(`/agencies/${agencyId}/assets/${assetId}/work-orders`, { method: 'POST', body: JSON.stringify({ kind, note: note.trim() || undefined }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not create it.');
      setBusy(false);
    }
  };
  return (
    <Sheet open title="New work order" onClose={onClose} busy={busy} footer={<Foot busy={busy} onClose={onClose} onSubmit={submit} label="Create" />}>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      <label className="field">
        <span>Asset</span>
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.statusLabel})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Work</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="repair">Repair</option>
          <option value="service">Service</option>
          <option value="inspection">Inspection</option>
          <option value="replace">Replace</option>
        </select>
      </label>
      <label className="field">
        <span>Note</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
    </Sheet>
  );
}
