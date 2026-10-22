'use client';
// Board "Agency routing rules": which station is offered a report first, and what happens if nobody
// accepts. A rule for an area wins; otherwise the station whose area covers the building; otherwise
// the nearest. "Test a postcode" shows who would get it.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { useToast, WithAgency, type MyAgency } from '@/components/Agency';

interface Rule {
  id: string;
  type: string;
  typeLabel: string;
  area: string | null;
  areaLabel: string;
  station: string;
  stationId: string;
  next: string | null;
  nextStationId: string | null;
  waitSeconds: number;
  priority: number;
  active: boolean;
}
interface Routing {
  defaults: { acceptSeconds: number; ifNobodyAccepts: string; nightHandover: string };
  types: { code: string; label: string }[];
  stations: { id: string; name: string }[];
  rules: Rule[];
}
type Opt = { id: string; name: string };

export default function AgencyRoutingPage() {
  return <WithAgency>{(a) => <RoutingRules key={a.id} agency={a} />}</WithAgency>;
}

function RoutingRules({ agency }: { agency: MyAgency }) {
  const [d, setD] = useState<Routing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Routing>(`/agencies/${agency.id}/routing`)
      .then(setD)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load routing rules.'));
  }, [agency.id]);
  useEffect(load, [load]);
  const toggle = async (r: Rule) => {
    try {
      setToast(
        (
          await api<{ message: string }>(`/agencies/${agency.id}/routing/rules/${r.id}`, {
            method: 'PUT',
            body: JSON.stringify({ incidentType: r.type, areaId: r.area, stationId: r.stationId, nextStationId: r.nextStationId, waitSeconds: r.waitSeconds, priority: r.priority, active: !r.active }),
          })
        ).message,
      );
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
          <h1>Routing rules</h1>
          <p className="lede">Which station is offered a report first, and what happens if nobody accepts.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" type="button" disabled={!d} onClick={() => setEdit('new')}>
            Add rule
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)' }}>
        <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="rules">
          <h2 id="rules" style={{ margin: 0, padding: '16px 16px 0' }}>
            Rules
          </h2>
          {!d ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" />
            </div>
          ) : !d.rules.length ? (
            <div className="empty">No rules yet. Reports go to the station whose area covers the building, then the nearest.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Report type</th>
                  <th>Area</th>
                  <th>First station</th>
                  <th>Wait</th>
                  <th>Then</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button type="button" className="link" onClick={() => setEdit(r)}>
                        <strong>{r.typeLabel}</strong>
                      </button>
                      {r.priority > 1 && <div className="muted">Priority {r.priority}</div>}
                    </td>
                    <td>{r.areaLabel}</td>
                    <td>{r.station}</td>
                    <td>{r.waitSeconds}s</td>
                    <td>{r.next ?? 'Nearest station'}</td>
                    <td>
                      <button type="button" className="link" onClick={() => toggle(r)} style={{ color: r.active ? 'var(--color-success-text)' : 'var(--color-warning-text)', fontWeight: 700 }}>
                        {r.active ? 'Active' : 'Paused'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {d && <TestPostcode agencyId={agency.id} types={d.types} />}
      </div>
      {d && (
        <div className="grid two">
          <Defaults agencyId={agency.id} d={d.defaults} onSaved={(m) => (setToast(m), load())} />
          <section className="card" aria-labelledby="how">
            <h2 id="how" style={{ marginTop: 0 }}>
              How it works
            </h2>
            <p>The report is offered to the first station. If nobody accepts before the wait ends, it goes to the next one, and the platform team is told after the second miss.</p>
            <p>Without a rule, the station whose area covers the building is offered it first, then the nearest. A station head can reassign a report at any time, and every change is logged.</p>
          </section>
        </div>
      )}
      {edit && d && <RuleSheet agencyId={agency.id} d={d} rule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={(m) => (setEdit(null), setToast(m), load())} />}
    </>
  );
}

function TestPostcode({ agencyId, types }: { agencyId: string; types: { code: string; label: string }[] }) {
  const [postcode, setPostcode] = useState('');
  const [type, setType] = useState(types[0]?.code ?? '');
  const [r, setR] = useState<{ first: string | null; then: string | null; why: string; area?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setR(await api(`/agencies/${agencyId}/routing/test`, { method: 'POST', body: JSON.stringify({ postcode: postcode.trim(), type }) }));
    } catch (e) {
      setR(null);
      setErr(e instanceof ApiError ? e.message : 'Could not test it.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="test">
      <h2 id="test" style={{ marginTop: 0 }}>
        Test a postcode
      </h2>
      <label className="field" data-invalid={!!err}>
        <span>Postcode</span>
        <input type="text" value={postcode} onChange={(e) => setPostcode(e.target.value.toUpperCase())} placeholder="AB12C" />
        {err && <span className="field-error">{err}</span>}
      </label>
      <label className="field">
        <span>Report type</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <button className="btn signal" type="button" style={{ width: '100%' }} disabled={busy || postcode.trim().length < 3} onClick={run}>
        Show who gets it
      </button>
      {r && (
        <div className="banner info" style={{ margin: '12px 0 0' }}>
          <small className="muted">Result{r.area ? ` for ${r.area}` : ''}</small>
          <strong style={{ display: 'block' }}>{r.first ? `${r.first} first${r.then ? `, then ${r.then}` : ''}` : 'Nobody'}</strong>
          {r.why}
        </div>
      )}
    </section>
  );
}

function Defaults({ agencyId, d, onSaved }: { agencyId: string; d: Routing['defaults']; onSaved: (m: string) => void }) {
  const [f, setF] = useState({ accept: String(d.acceptSeconds), nobody: d.ifNobodyAccepts, night: d.nightHandover });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      onSaved((await api<{ message: string }>(`/agencies/${agencyId}/routing/defaults`, { method: 'PUT', body: JSON.stringify({ acceptSeconds: Number(f.accept), ifNobodyAccepts: f.nobody, nightHandover: f.night }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="def">
      <h2 id="def" style={{ marginTop: 0 }}>
        Defaults
      </h2>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '0 0 8px' }}>
          {err}
        </div>
      )}
      <label className="field">
        <span>Seconds to accept an offer</span>
        <input inputMode="numeric" value={f.accept} onChange={(e) => setF({ ...f, accept: e.target.value.replace(/\D/g, '') })} />
      </label>
      <label className="field">
        <span>If nobody accepts</span>
        <select value={f.nobody} onChange={(e) => setF({ ...f, nobody: e.target.value })}>
          <option value="next_nearest">Send to the next nearest station</option>
          <option value="next_in_rule">Send to the station named in the rule</option>
          <option value="platform">Tell the platform team</option>
        </select>
      </label>
      <label className="field">
        <span>Night shift handover</span>
        <input type="time" value={f.night} onChange={(e) => setF({ ...f, night: e.target.value })} />
      </label>
      <button className="btn primary" type="button" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save defaults'}
      </button>
    </section>
  );
}

function RuleSheet({ agencyId, d, rule, onClose, onDone }: { agencyId: string; d: Routing; rule: Rule | null; onClose: () => void; onDone: (m: string) => void }) {
  const [type, setType] = useState(rule?.type ?? d.types[0]?.code ?? '');
  const [areaId, setAreaId] = useState(rule?.area ?? '');
  const [areaLabel, setAreaLabel] = useState(rule?.areaLabel ?? 'All areas');
  const [stationId, setStationId] = useState(rule?.stationId ?? d.stations[0]?.id ?? '');
  const [nextId, setNextId] = useState(rule?.nextStationId ?? '');
  const [wait, setWait] = useState(String(rule?.waitSeconds ?? d.defaults.acceptSeconds));
  const [priority, setPriority] = useState(String(rule?.priority ?? 1));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Area: State → LGA → District → Area from the postcode service; the deepest chosen is used.
  const [pick, setPick] = useState<{ state?: string; lga?: string; district?: string; area?: string }>({});
  const [opts, setOpts] = useState<{ state?: Opt[]; lga?: Opt[]; district?: Opt[]; area?: Opt[] }>({});
  useEffect(() => {
    const load = (level: 'state' | 'lga' | 'district' | 'area', parent?: string) =>
      api<Opt[]>(`/places/levels/${level}${parent ? `?parent=${encodeURIComponent(parent)}` : ''}`)
        .then((xs) => setOpts((o) => ({ ...o, [level]: xs })))
        .catch(() => {});
    void load('state');
    if (pick.state) void load('lga', pick.state);
    if (pick.lga) void load('district', pick.lga);
    if (pick.district) void load('area', pick.district);
  }, [pick.state, pick.lga, pick.district]);
  const choose = (level: 'state' | 'lga' | 'district' | 'area', id: string) => {
    const next = { ...pick, [level]: id || undefined };
    if (level === 'state') Object.assign(next, { lga: undefined, district: undefined, area: undefined });
    if (level === 'lga') Object.assign(next, { district: undefined, area: undefined });
    if (level === 'district') Object.assign(next, { area: undefined });
    setPick(next);
    const deep = next.area ? ['area', next.area] : next.district ? ['district', next.district] : next.lga ? ['lga', next.lga] : null;
    if (deep) {
      setAreaId(deep[1]!);
      setAreaLabel(opts[deep[0] as 'area']?.find((o) => o.id === deep[1])?.name ?? deep[1]!);
    } else {
      setAreaId('');
      setAreaLabel('All areas');
    }
  };
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { incidentType: type, areaId: areaId || null, stationId, nextStationId: nextId || null, waitSeconds: Number(wait), priority: Number(priority) };
      onDone((await api<{ message: string }>(rule ? `/agencies/${agencyId}/routing/rules/${rule.id}` : `/agencies/${agencyId}/routing/rules`, { method: rule ? 'PUT' : 'POST', body: JSON.stringify(body) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not save the rule.');
      setBusy(false);
    }
  };
  const sel = (level: 'state' | 'lga' | 'district' | 'area', label: string, all: string, disabled: boolean) => (
    <label className="field" style={{ margin: 0 }}>
      <span>{label}</span>
      <select value={pick[level] ?? ''} disabled={disabled} onChange={(e) => choose(level, e.target.value)}>
        <option value="">{all}</option>
        {(disabled ? [] : (opts[level] ?? [])).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Sheet
      open
      title={rule ? 'Edit rule' : 'Add rule'}
      description="The first station is offered the report; after the wait, the next one."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy || !stationId || !type}>
            Save rule
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
        <span>Report type</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {d.types.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend>Area: {areaLabel}</legend>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {sel('state', 'State', 'All states', false)}
          {sel('lga', 'LGA', 'All LGAs', !pick.state)}
          {sel('district', 'District', 'Whole LGA', !pick.lga)}
          {sel('area', 'Area', 'Whole district', !pick.district)}
        </div>
      </fieldset>
      <label className="field">
        <span>First station</span>
        <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
          {d.stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Seconds to wait</span>
        <input inputMode="numeric" value={wait} onChange={(e) => setWait(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label className="field">
        <span>Then</span>
        <select value={nextId} onChange={(e) => setNextId(e.target.value)}>
          <option value="">The nearest other station</option>
          {d.stations
            .filter((s) => s.id !== stationId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
      <label className="field">
        <span>Priority (1 is tried first)</span>
        <input inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value.replace(/\D/g, ''))} />
      </label>
    </Sheet>
  );
}
