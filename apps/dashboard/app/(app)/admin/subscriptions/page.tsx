'use client';
// Board "Admin subscriptions": households and communities paying for cameras and street lights.
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { naira } from '@/components/Dash';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Sub {
  id: string;
  owner: string;
  postcode: string;
  area: string;
  plan: string;
  priceKobo: number;
  devices: number;
  cameras: number;
  lights: number;
  state: string;
  nextBill: string | null;
  lastPaid: string | null;
  installPaid: string | null;
  dueSince: string | null;
  arrangement: string | null;
}
interface D {
  stats: { active: number; monthlyKobo: number; due: number; cancelledMonth: number };
  items: Sub[];
}
type F = 'all' | 'active' | 'due' | 'install' | 'cancelled';
const STATE: Record<string, [string, string]> = {
  active: ['Active', 'var(--color-success-text)'],
  grace: ['Payment due', 'var(--color-warning-text)'],
  extras_paused: ['Extras paused', 'var(--color-warning-text)'],
  sharing_paused: ['Sharing paused', 'var(--color-warning-text)'],
  switched_off: ['Switched off', 'var(--color-emergency-text)'],
  install_pending: ['Install pending', 'var(--color-signal-text)'],
  install_booked: ['Install booked', 'var(--color-signal-text)'],
  paused: ['Paused', 'var(--color-text-secondary)'],
  cancelled: ['Cancelled', 'var(--color-text-secondary)'],
};
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');

export default function Subscriptions() {
  const [f, setF] = useState<F>('all');
  const [d, setD] = useState<D | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loc, setLoc] = useState<LocFilter>({});
  const lq = locQuery(loc);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<D>(`/admin/subscriptions?status=${f}${lq ? `&${lq}` : ''}`)
      .then((x) => {
        setD(x);
        setSel((s) => (s && x.items.some((i) => i.id === s) ? s : (x.items[0]?.id ?? null)));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load subscriptions.'));
  }, [f, lq]);
  useEffect(load, [load]);
  const s = d?.items.find((x) => x.id === sel);
  const act = async (body: object) => {
    if (!s) return;
    try {
      setToast((await api<{ message: string }>(`/admin/subscriptions/${s.id}`, { method: 'POST', body: JSON.stringify(body) })).message);
      setReason('');
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not do that.');
    }
  };
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Subscriptions</h1>
          <p className="lede">Households and communities paying for cameras and street lights.</p>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Active subscriptions</span>
          <strong className="success">{d?.stats.active ?? '—'}</strong>
          <small>Paying now</small>
        </div>
        <div className="stat">
          <span>Monthly recurring</span>
          <strong>{d ? naira(d.stats.monthlyKobo) : '—'}</strong>
          <small>Before Paystack fees</small>
        </div>
        <div className="stat">
          <span>Payment due</span>
          <strong className="warning">{d?.stats.due ?? '—'}</strong>
          <small>Failed or late</small>
        </div>
        <div className="stat">
          <span>Cancelled this month</span>
          <strong>{d?.stats.cancelledMonth ?? '—'}</strong>
          <small>&nbsp;</small>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {(
          [
            ['all', 'All'],
            ['active', 'Active'],
            ['due', 'Payment due'],
            ['install', 'Install pending'],
            ['cancelled', 'Cancelled'],
          ] as [F, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={f === k} aria-pressed={f === k} onClick={() => setF(k)}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {!d?.items.length ? (
            <div className="empty">{d ? 'None here.' : <span className="skeleton" />}</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Postcode</th>
                  <th>Plan</th>
                  <th>Devices</th>
                  <th>Next bill</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((x) => (
                  <tr key={x.id} className="link" onClick={() => setSel(x.id)} style={sel === x.id ? { background: 'var(--color-signal-soft)' } : undefined}>
                    <td>
                      <strong>{x.owner}</strong>
                    </td>
                    <td>{x.postcode}</td>
                    <td>{x.plan}</td>
                    <td>{x.devices}</td>
                    <td>{x.state.startsWith('install') ? 'Not started' : day(x.nextBill)}</td>
                    <td>
                      <strong style={{ color: STATE[x.state]?.[1] }}>{STATE[x.state]?.[0] ?? x.state}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {s && (
          <section className="card" aria-labelledby="sel">
            <h2 id="sel" style={{ marginTop: 0 }}>
              Selected: {s.owner}
            </h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Postcode {s.postcode}, {s.area}
            </p>
            <div className="chips" style={{ marginBottom: 12 }}>
              <span className="chip neutral">Plan: {s.plan}</span>
              <span className="chip neutral">
                {s.cameras} {s.cameras === 1 ? 'camera' : 'cameras'}, {s.lights} {s.lights === 1 ? 'light' : 'lights'}
              </span>
            </div>
            <p style={{ marginTop: 0 }}>
              Install fee paid {day(s.installPaid)}. Last payment {day(s.lastPaid)}.
              {s.dueSince ? ` Due since ${day(s.dueSince)}.` : ''}
              {s.arrangement ? ' Payment plan asked.' : ''}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="btn" aria-label="Change plan" value="" onChange={(e) => e.target.value && act({ action: 'change_plan', planCode: e.target.value })}>
                <option value="">Change plan…</option>
                <option value="household">Household</option>
                <option value="household_plus">Household Plus</option>
                <option value="community">Community</option>
              </select>
              <button className="btn" type="button" onClick={() => act({ action: 'remind' })}>
                Send reminder
              </button>
            </div>
            {(s.state === 'active' || s.state === 'grace' || s.state === 'paused') && (
              <>
                <label className="field" style={{ marginTop: 12 }}>
                  <span>{s.state === 'paused' ? 'Reason to resume (logged)' : 'Reason to pause (logged)'}</span>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                </label>
                <button className="btn" type="button" onClick={() => act({ action: s.state === 'paused' ? 'resume' : 'pause', reason })}>
                  {s.state === 'paused' ? 'Resume' : 'Pause'}
                </button>
              </>
            )}
          </section>
        )}
      </div>
    </>
  );
}
