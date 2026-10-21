'use client';
// Board "Station settings": profile, how reports reach the station, alerts and access.
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface S {
  canEdit: boolean;
  name: string;
  agency: string;
  postcode: string | null;
  phone: string | null;
  headUserId: string | null;
  people: { id: string; name: string }[];
  acceptWindowSeconds: number;
  minOnDuty: number;
  settings: { openingHours: string; ifNobodyAccepts: string; alerts: Record<string, boolean> };
  areas: { area_id?: string; lga_id?: string; district_id?: string }[];
  access: { head: number; dispatcher: number; officer: number };
}
const ALERTS: [string, string, string][] = [
  ['newOffer', 'New report offered', 'Sound and push to officers on duty'],
  ['nobodyAccepted', 'Nobody accepted in time', 'Push and SMS to the station head'],
  ['tamper', 'Tamper alert in my zone', 'Push to the station head'],
  ['dailySummary', 'Daily summary', 'Email to the station head'],
];

export default function StationSettings() {
  const [s, setS] = useState<S | null>(null);
  const [form, setForm] = useState<{ phone: string; accept: string; min: string; opening: string; nobody: string; alerts: Record<string, boolean> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  useEffect(() => {
    api<S>('/me/station/settings')
      .then((x) => {
        setS(x);
        setForm({ phone: x.phone ?? '', accept: String(x.acceptWindowSeconds), min: String(x.minOnDuty), opening: x.settings.openingHours, nobody: x.settings.ifNobodyAccepts, alerts: x.settings.alerts });
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load settings.'));
  }, []);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    setErr(null);
    try {
      setToast(
        (
          await api<{ message: string }>('/me/station/settings', {
            method: 'PATCH',
            body: JSON.stringify({ phone: form.phone || undefined, acceptWindowSeconds: Number(form.accept), minOnDuty: Number(form.min), openingHours: form.opening, ifNobodyAccepts: form.nobody, alerts: form.alerts }),
          })
        ).message,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const ro = !s?.canEdit;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="lede">Station profile, how reports reach it, alerts and access.</p>
        </div>
        <button className="btn primary" type="button" onClick={save} disabled={busy || ro || !form}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      {ro && s && <div className="banner info">Only the station head can change these.</div>}
      {form && s && (
        <>
          <div className="grid two">
            <section className="card" aria-labelledby="prof">
              <h2 id="prof" style={{ marginTop: 0 }}>
                Station profile
              </h2>
              <dl className="facts">
                <div>
                  <dt>Station name</dt>
                  <dd>{s.name}</dd>
                </div>
                <div>
                  <dt>Agency</dt>
                  <dd>{s.agency}</dd>
                </div>
                <div>
                  <dt>Building (postcode)</dt>
                  <dd>{s.postcode ?? '—'}</dd>
                </div>
                <div>
                  <dt>Station head</dt>
                  <dd>{s.people.find((x) => x.id === s.headUserId)?.name ?? 'Not set'}</dd>
                </div>
              </dl>
              <label className="field" style={{ marginTop: 12 }}>
                <span>Phone</span>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={ro} placeholder="+234" />
              </label>
              <label className="field">
                <span>Opening hours</span>
                <select value={form.opening} onChange={(e) => setForm({ ...form, opening: e.target.value })} disabled={ro}>
                  <option value="always">Always open</option>
                  <option value="office">Office hours only</option>
                </select>
              </label>
              <p className="muted" style={{ marginBottom: 0 }}>
                Name, building and head change through the agency, which keeps a record.
              </p>
            </section>
            <section className="card" aria-labelledby="how">
              <h2 id="how" style={{ marginTop: 0 }}>
                How reports reach us
              </h2>
              <label className="field">
                <span>Seconds to accept an offer</span>
                <input inputMode="numeric" value={form.accept} onChange={(e) => setForm({ ...form, accept: e.target.value.replace(/\D/g, '') })} disabled={ro} />
              </label>
              <label className="field">
                <span>Minimum officers on duty per shift</span>
                <input inputMode="numeric" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value.replace(/\D/g, '') })} disabled={ro} />
              </label>
              <label className="field">
                <span>If nobody accepts</span>
                <select value={form.nobody} onChange={(e) => setForm({ ...form, nobody: e.target.value })} disabled={ro}>
                  <option value="next_officer_then_station">Offer to the next officer, then the next station</option>
                  <option value="next_station">Go straight to the next station</option>
                </select>
              </label>
              <p className="muted" style={{ marginBottom: 0 }}>
                Who can reassign a report: the station head and dispatchers.
              </p>
            </section>
          </div>
          <div className="grid two">
            <section className="card" aria-labelledby="alerts">
              <h2 id="alerts" style={{ marginTop: 0 }}>
                Alerts
              </h2>
              {ALERTS.map(([k, t, l]) => (
                <div className="row" key={k}>
                  <div className="label">
                    <strong>{t}</strong>
                    <span>{l}</span>
                  </div>
                  <button className="toggle" type="button" role="switch" aria-checked={!!form.alerts[k]} aria-label={t} disabled={ro} onClick={() => setForm({ ...form, alerts: { ...form.alerts, [k]: !form.alerts[k] } })} />
                </div>
              ))}
            </section>
            <section className="card" aria-labelledby="acc">
              <h2 id="acc" style={{ marginTop: 0 }}>
                Access
              </h2>
              {(
                [
                  ['Station head', 'Everything at this station', s.access.head],
                  ['Dispatcher', 'Reassign, reinforce, transfer', s.access.dispatcher],
                  ['Officer', 'Own reports and roster', s.access.officer],
                ] as [string, string, number][]
              ).map(([t, l, n]) => (
                <div className="row" key={t}>
                  <div className="label">
                    <strong>{t}</strong>
                    <span>{l}</span>
                  </div>
                  <strong>{n}</strong>
                </div>
              ))}
              <p className="muted" style={{ marginBottom: 0 }}>
                Officers see device clips only for reports assigned to them, while the report is open. Every view is logged.
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}
