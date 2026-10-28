'use client';
// Fleet and access: a platform admin switches smart-device access on for an agency when onboarding it, and
// registers the devices it may run (smart street light, drones, body cams, cameras, sensors).
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface Fleet {
  agencies: { id: string; name: string; deviceAccess: boolean }[];
  types: { code: string; label: string }[];
  devices: { id: string; type: string; label: string; name: string; serial: string; status: string; state: string; agency: string | null; station: string | null; officer: string | null; battery: number | null }[];
}

export default function FleetPage() {
  const [f, setF] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, say] = useToast();
  const [form, setForm] = useState({ type: 'smart_pole', serial: '', name: '', agencyId: '', lat: '', lng: '' });
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Fleet>('/admin/fleet')
      .then(setF)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the fleet.'));
  }, []);
  useEffect(load, [load]);

  const toggle = async (id: string, enabled: boolean) => {
    try {
      say((await api<{ message: string }>(`/admin/agencies/${id}/device-access`, { method: 'POST', body: JSON.stringify({ enabled }) })).message);
      load();
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Could not change that.');
    }
  };
  const register = async () => {
    setBusy(true);
    setFieldErr({});
    try {
      const body = { type: form.type, serial: form.serial, name: form.name || undefined, agencyId: form.agencyId, lat: form.lat ? Number(form.lat) : undefined, lng: form.lng ? Number(form.lng) : undefined };
      say((await api<{ message: string }>('/admin/fleet/devices', { method: 'POST', body: JSON.stringify(body) })).message);
      setForm({ ...form, serial: '', name: '' });
      load();
    } catch (e) {
      if (e instanceof ApiError) {
        setFieldErr(Object.fromEntries((e.fields ?? []).map((x: { field: string; message: string }) => [x.field, x.message])));
        say(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <div className="banner critical" role="alert">
        {error}
      </div>
    );
  if (!f) return <div className="skeleton" style={{ height: 240 }} />;
  return (
    <>
      {toast}
      <header className="page-head">
        <h1>Fleet and access</h1>
        <p className="muted">Switch on smart devices for an agency when you onboard it, then register the devices it can run from its control centre.</p>
      </header>
      <div className="grid two">
        <section className="card" aria-labelledby="acc">
          <h2 id="acc" style={{ marginTop: 0 }}>
            Who can run smart devices
          </h2>
          {f.agencies.map((a) => (
            <div className="row" key={a.id}>
              <div className="label">
                <strong>{a.name}</strong>
                <span>{a.deviceAccess ? 'Control centre on' : 'Off'}</span>
              </div>
              <button className="toggle" type="button" role="switch" aria-checked={a.deviceAccess} aria-label={`Smart devices for ${a.name}`} onClick={() => void toggle(a.id, !a.deviceAccess)} />
            </div>
          ))}
        </section>
        <section className="card" aria-labelledby="reg">
          <h2 id="reg" style={{ marginTop: 0 }}>
            Register a device
          </h2>
          <label className="field">
            <span>Product</span>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {f.types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" data-invalid={!!fieldErr.agencyId}>
            <span>Agency (device access must be on)</span>
            <select value={form.agencyId} onChange={(e) => setForm({ ...form, agencyId: e.target.value })}>
              <option value="">Choose</option>
              {f.agencies.filter((a) => a.deviceAccess).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" data-invalid={!!fieldErr.serial}>
            <span>Serial number</span>
            <input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} />
            {fieldErr.serial && <span className="field-error">{fieldErr.serial}</span>}
          </label>
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Allen Avenue smart pole" />
          </label>
          <div className="grid two" style={{ marginBottom: 0 }}>
            <label className="field">
              <span>Latitude</span>
              <input inputMode="decimal" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />
            </label>
            <label className="field">
              <span>Longitude</span>
              <input inputMode="decimal" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />
            </label>
          </div>
          <button className="btn primary" type="button" disabled={busy || !form.serial || !form.agencyId} onClick={register}>
            {busy ? 'Saving…' : 'Register device'}
          </button>
        </section>
      </div>
      <section className="card" aria-labelledby="all">
        <h2 id="all" style={{ marginTop: 0 }}>
          Registered devices ({f.devices.length})
        </h2>
        {f.devices.map((d) => (
          <div className="row" key={d.id}>
            <div className="label">
              <strong>{d.name}</strong>
              <span>
                {d.label} · {d.serial} · {d.agency}
                {d.officer ? ` · ${d.officer}` : ''}
              </span>
            </div>
            <span className="muted">{d.status.replace('_', ' ')}</span>
          </div>
        ))}
      </section>
    </>
  );
}
