'use client';
// Board "Station settings": profile, how reports reach the station, alerts and access.
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface Area {
  level: 'lga' | 'district' | 'area';
  areaId: string;
  label: string;
}
const LEVEL_LABEL: Record<Area['level'], string> = { lga: 'Whole LGA', district: 'District', area: 'Area' };

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
  areas: Area[];
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
          <Coverage areas={s.areas} ro={ro} onSaved={setToast} />
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

type Opt = { id: string; name: string };

/** "Area this station covers": reports from here are offered to this station before any other. */
function Coverage({ areas: initial, ro, onSaved }: { areas: Area[]; ro: boolean; onSaved: (m: string) => void }) {
  const [areas, setAreas] = useState<Area[]>(initial);
  const [pick, setPick] = useState<{ state?: string; lga?: string; district?: string; area?: string }>({});
  const [opts, setOpts] = useState<{ state?: Opt[]; lga?: Opt[]; district?: Opt[]; area?: Opt[] }>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = (level: 'state' | 'lga' | 'district' | 'area', parent?: string) =>
      api<Opt[]>(`/places/levels/${level}${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`)
        .then((xs) => setOpts((o) => ({ ...o, [level]: xs })))
        .catch(() => setErr('Postcode lookup is not available.'));
    void load('state');
    if (pick.state) void load('lga', pick.state);
    if (pick.lga) void load('district', pick.lga);
    if (pick.district) void load('area', pick.district);
  }, [pick.state, pick.lga, pick.district]);
  // The deepest level chosen is what gets added.
  const chosen: Area | null = pick.area
    ? { level: 'area', areaId: pick.area, label: opts.area?.find((o) => o.id === pick.area)?.name ?? pick.area }
    : pick.district
      ? { level: 'district', areaId: pick.district, label: opts.district?.find((o) => o.id === pick.district)?.name ?? pick.district }
      : pick.lga
        ? { level: 'lga', areaId: pick.lga, label: opts.lga?.find((o) => o.id === pick.lga)?.name ?? pick.lga }
        : null;
  const save = async (next: Area[]) => {
    setBusy(true);
    setErr(null);
    try {
      onSaved((await api<{ message: string }>('/me/station/areas', { method: 'PUT', body: JSON.stringify({ areas: next }) })).message);
      setAreas(next);
      setPick({});
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the area.');
    } finally {
      setBusy(false);
    }
  };
  const sel = (key: 'state' | 'lga' | 'district' | 'area', label: string, all: string, disabled: boolean, reset: Partial<typeof pick>) => (
    <label className="field" style={{ margin: 0 }}>
      <span>{label}</span>
      <select value={pick[key] ?? ''} disabled={disabled || ro} onChange={(e) => setPick({ ...pick, ...reset, [key]: e.target.value || undefined })}>
        <option value="">{all}</option>
        {(disabled ? [] : (opts[key] ?? [])).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="card" aria-labelledby="cov">
      <h2 id="cov" style={{ marginTop: 0 }}>
        Area this station covers
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Reports from these places are offered to your officers first. A report from outside every station&apos;s area goes to the nearest station and is marked as outside its area.
      </p>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '0 0 8px' }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {!areas.length && <span className="chip warning">No area set. Reports reach you only as the nearest station.</span>}
        {areas.map((a) => (
          <span key={`${a.level}:${a.areaId}`} className="chip info" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {LEVEL_LABEL[a.level]}: {a.label}
            {!ro && areas.length > 1 && (
              <button type="button" className="link" aria-label={`Remove ${a.label}`} disabled={busy} onClick={() => save(areas.filter((x) => x !== a))}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {!ro && (
        <div className="loc-grid">
          {sel('state', 'State', 'Choose a state', false, { lga: undefined, district: undefined, area: undefined })}
          {sel('lga', 'LGA', 'Choose an LGA', !pick.state, { district: undefined, area: undefined })}
          {sel('district', 'District', 'Whole LGA', !pick.lga, { area: undefined })}
          {sel('area', 'Area', 'Whole district', !pick.district, {})}
          <button
            className="btn"
            type="button"
            style={{ alignSelf: 'end' }}
            disabled={busy || !chosen || areas.some((a) => a.level === chosen.level && a.areaId === chosen.areaId)}
            onClick={() => chosen && save([...areas, chosen])}
          >
            {busy ? 'Saving…' : 'Add to area'}
          </button>
        </div>
      )}
    </section>
  );
}
