'use client';
// Board "Agency asset detail": status, signal plan, maintenance, remote actions (safety plan and a
// second approver required) and fault history.
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { dateTime, shortDate, useToast, WithAgency, type MyAgency } from '@/components/Agency';
import { ago } from '@/components/Dash';

interface Asset {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  postcode: string | null;
  status: string;
  statusLabel: string;
  fault: string | null;
  lastSignal: string | null;
  power: string | null;
  batteryPct: number | null;
  controller: string | null;
  installedOn: string | null;
  maintenance: { lastService: string | null; nextService: string | null; warrantyUntil: string | null };
  signalPlan: Record<string, string>;
  planChanged: { at: string; by: string } | null;
  openFault: { since: string; what: string } | null;
  faults: { at: string; what: string }[];
  workOrders: { number: string; kind: string; state: string; note: string | null; at: string; by: string }[];
  actions: { id: string; label: string; state: string; at: string; requestedBy: string; approvedBy: string | null; canApprove: boolean }[];
  safetyPlanSigned: boolean;
}
const TONE: Record<string, string> = { online: 'var(--color-success-text)', low_power: 'var(--color-warning-text)', offline: 'var(--color-text-secondary)', fault: 'var(--color-emergency-text)' };

export default function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <WithAgency>{(a) => <AssetDetail key={a.id} agency={a} id={id} />}</WithAgency>;
}

function AssetDetail({ agency, id }: { agency: MyAgency; id: string }) {
  const [a, setA] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Asset>(`/agencies/${agency.id}/assets/${id}`)
      .then(setA)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the asset.'));
  }, [agency.id, id]);
  useEffect(load, [load]);
  const post = async (path: string, body: object) => {
    setBusy(true);
    try {
      setToast((await api<{ message: string }>(`/agencies/${agency.id}/${path}`, { method: 'POST', body: JSON.stringify(body) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not do that.');
    } finally {
      setBusy(false);
    }
  };
  const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) => (
    <div className="row">
      <span className="muted">{k}</span>
      <strong style={{ color: tone, textAlign: 'right' }}>{v}</strong>
    </div>
  );
  if (error) {
    return (
      <div className="card empty">
        <strong>{error}</strong>
        <Link href="/agency/assets">Back to assets</Link>
      </div>
    );
  }
  if (!a) return <div className="skeleton" style={{ height: 300 }} />;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>
            {a.name}
            {a.postcode ? `, ${a.postcode}` : ''}
          </h1>
          <p className="lede">
            {a.kindLabel}
            {a.installedOn ? `, installed ${shortDate(a.installedOn)}` : ''}
            {a.controller ? `, controller ${a.controller}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" href="/agency/assets">
            Back to assets
          </Link>
          <button className="btn signal" type="button" disabled={busy} onClick={() => post(`assets/${a.id}/work-orders`, { kind: a.status === 'fault' ? 'repair' : 'service' })}>
            Create work order
          </button>
        </div>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="st">
          <h2 id="st" style={{ marginTop: 0 }}>
            Status
          </h2>
          <Row k="Signal" v={a.status === 'fault' && a.fault ? `Fault: ${a.fault}` : a.statusLabel} tone={TONE[a.status]} />
          <Row k="Controller link" v={a.lastSignal ? `${a.status === 'offline' ? 'Offline' : 'Online'}, ${ago(a.lastSignal)}` : 'Never'} tone={a.status === 'offline' ? undefined : 'var(--color-success-text)'} />
          <Row k="Power" v={`${a.power ?? 'Mains'}${a.batteryPct != null ? `, battery backup ${a.batteryPct}%` : ''}`} />
          {a.openFault && (
            <div className="banner critical" style={{ margin: '8px 0 0' }}>
              <strong style={{ display: 'block' }}>Open fault since {dateTime(a.openFault.since)}</strong>
              {a.openFault.what}
            </div>
          )}
        </section>
        <section className="card" aria-labelledby="sp">
          <h2 id="sp" style={{ marginTop: 0 }}>
            {a.kind === 'traffic_light' ? 'Signal plan' : 'Schedule'}
          </h2>
          {Object.keys(a.signalPlan).length ? (
            Object.entries(a.signalPlan).map(([k, v]) => <Row key={k} k={k[0]!.toUpperCase() + k.slice(1)} v={v} />)
          ) : (
            <p className="muted">No plan shared by the controller yet.</p>
          )}
          <Row k="Last changed" v={a.planChanged ? `${shortDate(a.planChanged.at)} by ${a.planChanged.by}` : '—'} />
        </section>
      </div>
      <section className="card" aria-labelledby="mt">
        <h2 id="mt" style={{ marginTop: 0 }}>
          Maintenance
        </h2>
        <Row k="Last service" v={a.maintenance.lastService ? shortDate(a.maintenance.lastService) : '—'} />
        <Row k="Next service" v={a.maintenance.nextService ? shortDate(a.maintenance.nextService) : 'Not booked'} />
        <Row k="Warranty" v={a.maintenance.warrantyUntil ? `Until ${shortDate(a.maintenance.warrantyUntil)}` : '—'} />
        {a.workOrders.map((w) => (
          <Row key={w.number} k={`${w.number}, ${w.kind}`} v={`${w.state.replace('_', ' ')}, ${w.by}, ${shortDate(w.at)}`} />
        ))}
      </section>
      <div className="grid two">
        {a.kind === 'traffic_light' && (
          <section className="card" aria-labelledby="ra">
            <h2 id="ra" style={{ marginTop: 0 }}>
              Remote actions
            </h2>
            {!a.safetyPlanSigned && (
              <div className="banner warning" style={{ margin: '0 0 12px' }}>
                <strong style={{ display: 'block' }}>Needs agency safety approval</strong>
                Remote changes are off until {agency.name} signs the safety plan in Settings. Every change then needs a second approver and is logged.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              {(
                [
                  ['restart', 'Restart controller'],
                  ['flashing_amber', 'Set flashing amber'],
                  ['manual_control', 'Request manual control'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className="btn" type="button" disabled={busy || !a.safetyPlanSigned} onClick={() => post(`assets/${a.id}/actions`, { action: k })}>
                  {l}
                </button>
              ))}
            </div>
            {a.actions.map((x) => (
              <div className="row" key={x.id}>
                <div className="label">
                  <strong>{x.label}</strong>
                  <span>
                    Asked by {x.requestedBy}, {dateTime(x.at)}
                    {x.approvedBy ? `, ${x.state === 'done' ? 'approved' : 'refused'} by ${x.approvedBy}` : ''}
                  </span>
                </div>
                {x.canApprove ? (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button className="btn small primary" type="button" disabled={busy} onClick={() => post(`asset-actions/${x.id}`, { approve: true })}>
                      Approve
                    </button>
                    <button className="btn small" type="button" disabled={busy} onClick={() => post(`asset-actions/${x.id}`, { approve: false })}>
                      Refuse
                    </button>
                  </span>
                ) : (
                  <span className={`chip ${x.state === 'done' ? 'success' : x.state === 'refused' ? 'neutral' : 'warning'}`}>{x.state === 'awaiting_approval' ? 'Waiting for a second admin' : x.state === 'done' ? 'Done' : 'Refused'}</span>
                )}
              </div>
            ))}
          </section>
        )}
        <section className="card" aria-labelledby="fh">
          <h2 id="fh" style={{ marginTop: 0 }}>
            Fault history
          </h2>
          {!a.faults.length ? <p className="muted">No faults recorded.</p> : a.faults.map((f, i) => <Row key={i} k={shortDate(f.at)} v={f.what} />)}
        </section>
      </div>
    </>
  );
}
