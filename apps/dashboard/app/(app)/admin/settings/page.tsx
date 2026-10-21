'use client';
// Platform admin settings. First section: the platform fee on bounties (Rewards doc:
// "The platform takes a fee of [%] on each bounty"), a suggestion plus the range agencies choose within.
import { formatNaira, percent } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface FeeSettings {
  suggestedBps: number;
  minBps: number;
  maxBps: number;
  earnedThisMonthKobo: number;
  agencies: { id: string; name: string; chosenBps: number; bps: number; outside: boolean }[];
}
type Field = 'suggestedBps' | 'minBps' | 'maxBps';
const FIELDS: [Field, string, string][] = [
  ['suggestedBps', 'Suggested fee (%)', 'What every agency pays unless it chooses its own.'],
  ['minBps', 'Lowest an agency can choose (%)', ''],
  ['maxBps', 'Highest an agency can choose (%)', ''],
];
const toPct = (bps: number) => String(bps / 100);

export default function AdminSettings() {
  const [data, setData] = useState<FeeSettings | null>(null);
  const [form, setForm] = useState<Record<Field, string>>({ suggestedBps: '', minBps: '', maxBps: '' });
  const [errs, setErrs] = useState<Partial<Record<Field | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [toast, setToast] = useToast();

  const load = () =>
    api<FeeSettings>('/admin/settings/bounty-fee')
      .then((d) => {
        setData(d);
        setForm({ suggestedBps: toPct(d.suggestedBps), minBps: toPct(d.minBps), maxBps: toPct(d.maxBps) });
      })
      .catch(setLoadError);
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    const body = Object.fromEntries(FIELDS.map(([k]) => [k, Math.round(Number(form[k]) * 100)])) as Record<Field, number>;
    const bad = FIELDS.find(([k]) => !form[k].trim() || !Number.isFinite(body[k]));
    if (bad) {
      setErrs({ [bad[0]]: 'Enter a fee between 0% and 50%.' });
      return;
    }
    setErrs({});
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/admin/settings/bounty-fee', { method: 'PUT', body: JSON.stringify(body) });
      setToast(r.message);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.fields?.length) setErrs(Object.fromEntries(e.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: e instanceof ApiError ? e.message : 'Could not save. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (loadError?.status === 403)
    return (
      <div className="card empty">
        <strong>This page is for platform staff.</strong>
      </div>
    );

  const example = 10_000_000;
  const sug = Math.round(Number(form.suggestedBps) * 100) || 0;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="lede">Platform-wide rules. Every change is written to the audit log.</p>
        </div>
      </div>

      <div className="bounty-grid">
        <section className="card" aria-labelledby="fee">
          <h2 id="fee" style={{ marginTop: 0 }}>
            Platform fee on bounties
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Taken on each bounty an agency approves, from its pool on top of the bounty. The tipper always gets the full amount. Agencies can change their own fee within the range.
          </p>
          {loadError && loadError.status !== 403 && (
            <div className="banner critical" role="alert">
              {loadError.message}
            </div>
          )}
          {errs.form && (
            <div className="banner critical" role="alert">
              {errs.form}
            </div>
          )}
          {!data ? (
            <div className="skeleton" style={{ height: 180 }} />
          ) : (
            <>
              {FIELDS.map(([k, label, hint]) => (
                <label key={k} className="field" data-invalid={!!errs[k]} style={{ marginBottom: 12 }}>
                  <span>{label}</span>
                  <input inputMode="decimal" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} aria-invalid={!!errs[k]} aria-label={label} />
                  {errs[k] ? <span className="field-error">{errs[k]}</span> : hint && <small className="muted">{hint}</small>}
                </label>
              ))}
              <p className="muted">
                Example: on a {formatNaira(example).replace('.00', '')} bounty the suggested fee is {formatNaira(Math.round((example * sug) / 10_000)).replace('.00', '')}.
              </p>
              <button className="btn primary" type="button" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save fee'}
              </button>
            </>
          )}
        </section>

        <section className="card" aria-labelledby="own">
          <h2 id="own" style={{ marginTop: 0 }}>
            Agencies with their own fee
          </h2>
          {data && (
            <p className="muted" style={{ marginTop: 0 }}>
              Fees earned this month: <strong style={{ color: 'var(--color-text-primary)' }}>{formatNaira(data.earnedThisMonthKobo).replace('.00', '')}</strong>
            </p>
          )}
          {!data ? (
            <div className="skeleton" />
          ) : !data.agencies.length ? (
            <p className="muted">All agencies use the suggested fee.</p>
          ) : (
            data.agencies.map((a) => (
              <div key={a.id} className="row" style={{ cursor: 'default' }}>
                <span style={{ flex: 1 }}>
                  {a.name}
                  {a.outside && (
                    <small className="muted" style={{ display: 'block' }}>
                      Chose {percent(a.chosenBps)}, outside the range, so pays {percent(a.bps)}
                    </small>
                  )}
                </span>
                <span className="chip neutral">{percent(a.bps)}</span>
              </div>
            ))
          )}
        </section>
      </div>
      <PlatformTeam onToast={setToast} />
    </>
  );
}

interface Team {
  roles: { role: string; label: string; note: string; n: number }[];
  members: { id: string; name: string; phone: string | null; role: string; roleLabel: string; isMe: boolean }[];
}

/** Platform team: who holds which platform role (role-based access). Only platform admins change it. */
function PlatformTeam({ onToast }: { onToast: (m: string) => void }) {
  const [t, setT] = useState<Team | null>(null);
  const [f, setF] = useState({ phone: '+234', name: '', role: 'platform_support' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api<Team>('/admin/team')
      .then(setT)
      .catch(() => setT(null));
  useEffect(() => {
    void load();
  }, []);
  const invite = async () => {
    setBusy(true);
    setErr(null);
    try {
      onToast((await api<{ message: string }>('/admin/team', { method: 'POST', body: JSON.stringify({ phone: f.phone.replace(/\s+/g, ''), name: f.name || undefined, role: f.role }) })).message);
      setF({ ...f, phone: '+234', name: '' });
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (m: Team['members'][number]) => {
    if (!window.confirm(`Remove ${m.name}'s ${m.roleLabel.toLowerCase()} access?`)) return;
    try {
      onToast((await api<{ message: string }>(`/admin/team/${m.id}/${m.role}`, { method: 'DELETE' })).message);
      void load();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Could not remove.');
    }
  };
  if (!t) return null;
  return (
    <div className="grid two">
      <section className="card" aria-labelledby="pt">
        <h2 id="pt" style={{ marginTop: 0 }}>
          Platform team
        </h2>
        {t.roles.map((r) => (
          <div className="row" key={r.role}>
            <div className="label">
              <strong>{r.label}</strong>
              <span>{r.note}</span>
            </div>
            <strong>{r.n}</strong>
          </div>
        ))}
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            Who has access
          </summary>
          {t.members.map((m) => (
            <div className="row" key={`${m.id}:${m.role}`}>
              <div className="label">
                <strong>
                  {m.name}
                  {m.isMe ? ' (you)' : ''}
                </strong>
                <span>
                  {m.roleLabel}
                  {m.phone ? `, ${m.phone}` : ''}
                </span>
              </div>
              {!m.isMe && (
                <button className="btn small" type="button" onClick={() => remove(m)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </details>
      </section>
      <section className="card" aria-labelledby="ptadd">
        <h2 id="ptadd" style={{ marginTop: 0 }}>
          Add a team member
        </h2>
        {err && (
          <div className="banner critical" role="alert" style={{ margin: '0 0 8px' }}>
            {err}
          </div>
        )}
        <label className="field">
          <span>Role</span>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {t.roles.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
          </select>
          <small className="muted">{t.roles.find((r) => r.role === f.role)?.note}</small>
        </label>
        <label className="field">
          <span>Phone</span>
          <input type="text" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </label>
        <label className="field">
          <span>Full name (if they are new)</span>
          <input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        </label>
        <button className="btn primary" type="button" onClick={invite} disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <p className="muted" style={{ marginBottom: 0 }}>
          Staff must use two-step login. Every change is in the audit log.
        </p>
      </section>
    </div>
  );
}
