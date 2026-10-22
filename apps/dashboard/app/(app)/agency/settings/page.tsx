'use client';
// Board "Agency settings": agency profile, team access by role, alerts, the traffic safety plan and
// the access log. Only agency admins change these; finance can read them.
import { ROLE_SCOPE_NOTE, type Role } from '@erp/domain';
import { api, ApiError, downloadFile } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { useToast, WithAgency, type MyAgency } from '@/components/Agency';

interface Settings {
  canEdit: boolean;
  profile: { name: string; kind: string; postcode: string | null; phone: string | null; email: string | null; status: string; pending: Record<string, string> | null };
  alerts: Record<string, boolean>;
  safetyPlanSigned: boolean;
  team: { role: Role; label: string; n: number }[];
  members: { id: string; name: string; role: string; roleLabel: string; station: string | null }[];
  stations: { id: string; name: string }[];
}
const ALERTS: [string, string, string][] = [
  ['noTaker', 'New report with no taker', 'SMS and in-app to the station head'],
  ['nobodyOnDuty', 'Station with nobody on duty', 'In-app to the agency head'],
  ['payout', 'Payout sent or failed', 'Email to finance'],
  ['weekly', 'Weekly summary', 'Email to the agency head'],
];
const KINDS: [string, string][] = [
  ['police', 'Police'],
  ['fire', 'Fire service'],
  ['health', 'Ambulance and health'],
  ['frsc', 'Road safety'],
  ['roads', 'Roads'],
  ['naptip', 'NAPTIP'],
];

export default function AgencySettingsPage() {
  return <WithAgency>{(a) => <AgencySettings key={a.id} agency={a} />}</WithAgency>;
}

function AgencySettings({ agency }: { agency: MyAgency }) {
  const [s, setS] = useState<Settings | null>(null);
  const [f, setF] = useState<{ name: string; kind: string; phone: string; email: string; alerts: Record<string, boolean>; safety: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Settings>(`/agencies/${agency.id}/settings`)
      .then((x) => {
        setS(x);
        setF({ name: x.profile.name, kind: x.profile.kind, phone: x.profile.phone ?? '', email: x.profile.email ?? '', alerts: x.alerts, safety: x.safetyPlanSigned });
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load settings.'));
  }, [agency.id]);
  useEffect(load, [load]);
  const save = async () => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      setToast(
        (
          await api<{ message: string }>(`/agencies/${agency.id}/settings`, {
            method: 'PATCH',
            body: JSON.stringify({ name: f.name, kind: f.kind, phone: f.phone || undefined, email: f.email || undefined, alerts: f.alerts, safetyPlanSigned: f.safety }),
          })
        ).message,
      );
      load();
    } catch (e) {
      setError(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (m: Settings['members'][number]) => {
    if (!window.confirm(`Remove ${m.name}'s ${m.roleLabel.toLowerCase()} access?`)) return;
    try {
      setToast((await api<{ message: string }>(`/agencies/${agency.id}/team/${m.id}/${m.role}`, { method: 'DELETE' })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not remove.');
    }
  };
  const ro = !s?.canEdit;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="lede">Agency profile, team access, alerts and privacy.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" type="button" onClick={save} disabled={busy || ro || !f}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {ro && s && <div className="banner info">Your role can see these settings. Only an agency admin can change them.</div>}
      {s && f && (
        <>
          <div className="grid two">
            <section className="card" aria-labelledby="prof">
              <h2 id="prof" style={{ marginTop: 0 }}>
                Agency profile
              </h2>
              <label className="field">
                <span>Agency name</span>
                <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={ro} />
              </label>
              <label className="field">
                <span>Type</span>
                <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} disabled={ro}>
                  {KINDS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Head office postcode</span>
                <input type="text" value={s.profile.postcode ?? ''} disabled />
              </label>
              <label className="field">
                <span>Contact phone</span>
                <input type="text" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} disabled={ro} placeholder="+234" />
              </label>
              <label className="field">
                <span>Contact email</span>
                <input type="text" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} disabled={ro} placeholder="name@example.com" />
              </label>
              <p className="muted" style={{ marginBottom: 0 }}>
                Approval status: {s.profile.status.replace(/_/g, ' ')}. Changes to the name or type are checked by the platform team.
                {s.profile.pending ? ` Waiting: ${Object.entries(s.profile.pending).map(([k, v]) => `${k} to “${v}”`).join(', ')}.` : ''}
              </p>
            </section>
            <section className="card" aria-labelledby="team">
              <h2 id="team" style={{ marginTop: 0 }}>
                Team access
              </h2>
              {s.team.map((t) => (
                <div className="row" key={t.role}>
                  <div className="label">
                    <strong>{t.label}</strong>
                    <span>{ROLE_SCOPE_NOTE[t.role]}</span>
                  </div>
                  <strong>{t.n} people</strong>
                </div>
              ))}
              <details style={{ margin: '8px 0' }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Who has access
                </summary>
                {s.members.map((m) => (
                  <div className="row" key={`${m.id}:${m.role}:${m.station}`}>
                    <div className="label">
                      <strong>{m.name}</strong>
                      <span>
                        {m.roleLabel}
                        {m.station ? `, ${m.station}` : ''}
                      </span>
                    </div>
                    {!ro && (
                      <button className="btn small" type="button" onClick={() => remove(m)}>
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </details>
              <button className="btn" type="button" style={{ width: '100%' }} disabled={ro} onClick={() => setInviting(true)}>
                Invite a team member
              </button>
            </section>
          </div>
          <div className="grid two">
            <section className="card" aria-labelledby="al">
              <h2 id="al" style={{ marginTop: 0 }}>
                Alerts
              </h2>
              {ALERTS.map(([k, t, l]) => (
                <div className="row" key={k}>
                  <div className="label">
                    <strong>{t}</strong>
                    <span>{l}</span>
                  </div>
                  <button className="toggle" type="button" role="switch" aria-checked={!!f.alerts[k]} aria-label={t} disabled={ro} onClick={() => setF({ ...f, alerts: { ...f.alerts, [k]: !f.alerts[k] } })} />
                </div>
              ))}
            </section>
            <section className="card" aria-labelledby="pr">
              <h2 id="pr" style={{ marginTop: 0 }}>
                Privacy and records
              </h2>
              <p>Officers can see device clips only for reports assigned to them, and only while the report is open. Every view is logged.</p>
              <p>Drones are flown by trained agency staff under the agency&apos;s own rules.</p>
              <div className="row">
                <div className="label">
                  <strong>Traffic signal safety plan signed</strong>
                  <span>Turns on remote actions for traffic lights. Each one still needs a second admin.</span>
                </div>
                <button className="toggle" type="button" role="switch" aria-checked={f.safety} aria-label="Safety plan signed" disabled={ro} onClick={() => setF({ ...f, safety: !f.safety })} />
              </div>
              <button className="btn" type="button" style={{ width: '100%', marginTop: 8 }} disabled={ro} onClick={() => downloadFile(`/agencies/${agency.id}/access-log.csv`, 'access-log.csv').catch((e) => setToast(e.message))}>
                Download access log
              </button>
            </section>
          </div>
        </>
      )}
      {inviting && s && <InviteSheet agencyId={agency.id} stations={s.stations} onClose={() => setInviting(false)} onDone={(m) => (setInviting(false), setToast(m), load())} />}
    </>
  );
}

function InviteSheet({ agencyId, stations, onClose, onDone }: { agencyId: string; stations: { id: string; name: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ name: '', phone: '+234', role: 'agency_finance', stationId: stations[0]?.id ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const station = f.role === 'head' || f.role === 'dispatcher';
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone((await api<{ message: string }>(`/agencies/${agencyId}/team`, { method: 'POST', body: JSON.stringify({ name: f.name || undefined, phone: f.phone.replace(/\s+/g, ''), role: f.role, stationId: station ? f.stationId : undefined }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not invite them.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Invite a team member"
      description="They sign in with their phone. Staff must use two-step login."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy}>
            Invite
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
        <span>Role</span>
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="agency_admin">Agency admin</option>
          <option value="agency_finance">Finance</option>
          <option value="head">Station head</option>
          <option value="dispatcher">Dispatcher</option>
        </select>
        <small className="muted">{ROLE_SCOPE_NOTE[f.role as Role]}</small>
      </label>
      {station && (
        <label className="field">
          <span>Station</span>
          <select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Phone</span>
        <input type="text" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </label>
      <label className="field">
        <span>Full name (if they are new)</span>
        <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
      </label>
    </Sheet>
  );
}
