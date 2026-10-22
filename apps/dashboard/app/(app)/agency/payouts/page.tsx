'use client';
// Board "Agency payouts" (rewards part): the reward for a rated response, how it is split
// between the officers on it, and how donations will be shared. The platform rewards pool pays.
import { formatNaira } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { dateTime, useToast, WithAgency, type MyAgency } from '@/components/Agency';

interface Summary {
  rule: { fiveStarKobo: number; fourStarPct: number; split: 'equal' | 'lead_first'; active: boolean };
  ruleSet: boolean;
  limits: { maxFiveStarKobo: number; dailyCapPerOfficerKobo: number; holdDays: number };
  month: { kobo: number; paid: number; skipped: number };
  donationShares: { officerPct: number; stationPct: number; agencyPct: number } | null;
  recent: { incidentId: string; title: string; station: string | null; stars: number; state: 'paid' | 'skipped'; reason: string | null; totalKobo: number; officers: { name: string; kobo: number }[]; at: string }[];
}
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');

export default function PayoutsPage() {
  return <WithAgency>{(a) => <Payouts key={a.id} agency={a} />}</WithAgency>;
}

function Payouts({ agency }: { agency: MyAgency }) {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const load = () =>
    api<Summary>(`/agencies/${agency.id}/rewards`)
      .then(setS)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load rewards.'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agency.id]);

  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Payouts</h1>
          <p className="lede">Rewards for rated responses, paid to your officers’ wallets from the platform rewards pool.</p>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Rewards this month</span>
          <strong className="success">{s ? naira(s.month.kobo) : '—'}</strong>
          <small>{s ? `${s.month.paid} ${s.month.paid === 1 ? 'response' : 'responses'}` : ''}</small>
        </div>
        <div className="stat">
          <span>Not paid</span>
          <strong>{s?.month.skipped ?? '—'}</strong>
          <small>Low rating, caps or checks</small>
        </div>
        <div className="stat">
          <span>Reward for 5 stars</span>
          <strong className="warning">{s ? (s.rule.active && s.ruleSet ? naira(s.rule.fiveStarKobo) : 'Off') : '—'}</strong>
          <small>{s ? `Held ${s.limits.holdDays} days before withdrawal` : ''}</small>
        </div>
      </div>
      {s && (
        <div className="bounty-grid">
          <section className="card" aria-labelledby="recent" style={{ overflowX: 'auto' }}>
            <h2 id="recent" style={{ marginTop: 0 }}>
              Recent rewards
            </h2>
            {!s.recent.length ? (
              <div className="empty">
                <strong>No rated responses yet.</strong>Rewards appear here when citizens rate your officers.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Response</th>
                    <th>Rating</th>
                    <th>Reward</th>
                    <th>Officers</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recent.map((r) => (
                    <tr key={r.incidentId}>
                      <td>
                        <strong>{r.title}</strong>
                        <div className="muted">
                          {r.station ? `${r.station} · ` : ''}
                          {dateTime(r.at)}
                        </div>
                      </td>
                      <td>{'★'.repeat(r.stars)}</td>
                      <td>{r.state === 'paid' ? <span className="chip success">{naira(r.totalKobo)}</span> : <span className="chip neutral" style={{ whiteSpace: 'normal' }}>{r.reason}</span>}</td>
                      <td>
                        {r.officers.length
                          ? r.officers.map((o) => (
                              <div key={o.name}>
                                {o.name} <span className="muted">{naira(o.kobo)}</span>
                              </div>
                            ))
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <div className="grid" style={{ alignContent: 'start' }}>
            <RuleForm agencyId={agency.id} s={s} onSaved={(m) => (setToast(m), void load())} />
            <SharesForm agencyId={agency.id} s={s} onSaved={(m) => (setToast(m), void load())} />
          </div>
        </div>
      )}
    </>
  );
}

function RuleForm({ agencyId, s, onSaved }: { agencyId: string; s: Summary; onSaved: (m: string) => void }) {
  const [five, setFive] = useState(String(s.rule.fiveStarKobo / 100));
  const [four, setFour] = useState(String(s.rule.fourStarPct));
  const [split, setSplit] = useState(s.rule.split);
  const [active, setActive] = useState(s.ruleSet ? s.rule.active : true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fiveK = Math.round(Number(five) * 100) || 0;
  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/agencies/${agencyId}/reward-rule`, { method: 'PUT', body: JSON.stringify({ fiveStarKobo: fiveK, fourStarPct: Number(four) || 0, split, active }) });
      onSaved(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="rule">
      <h2 id="rule" style={{ marginTop: 0 }}>
        Rewards for ratings
      </h2>
      <label className="field" style={{ marginBottom: 12 }}>
        <span>Reward for a 5-star response (₦)</span>
        <input inputMode="decimal" value={five} onChange={(e) => setFive(e.target.value)} aria-invalid={!!err} />
        <small className="muted">Up to {naira(s.limits.maxFiveStarKobo)}. 3 stars or fewer earn nothing.</small>
      </label>
      <label className="field" style={{ marginBottom: 12 }}>
        <span>A 4-star response earns (%)</span>
        <input inputMode="numeric" value={four} onChange={(e) => setFour(e.target.value)} />
        <small className="muted">{fiveK ? `That is ${naira(Math.floor((fiveK * (Number(four) || 0)) / 100))}.` : ''}</small>
      </label>
      <label className="field" style={{ marginBottom: 12 }}>
        <span>Split between officers on the response</span>
        <select value={split} onChange={(e) => setSplit(e.target.value as 'equal' | 'lead_first')}>
          <option value="lead_first">Lead officer half, the rest share the other half</option>
          <option value="equal">Everyone the same</option>
        </select>
      </label>
      <div className="row" style={{ marginBottom: 12 }}>
        <span style={{ flex: 1 }}>
          <strong>Pay rewards</strong>
          <small className="muted" style={{ display: 'block' }}>
            Each officer can earn up to {naira(s.limits.dailyCapPerOfficerKobo)} a day. Staff ratings and repeat raters are not rewarded.
          </small>
        </span>
        <button className="toggle" type="button" role="switch" aria-checked={active} aria-label="Pay rewards" onClick={() => setActive((v) => !v)} />
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      <button className="btn primary" type="button" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save rule'}
      </button>
    </section>
  );
}

function SharesForm({ agencyId, s, onSaved }: { agencyId: string; s: Summary; onSaved: (m: string) => void }) {
  const d = s.donationShares ?? { officerPct: 50, stationPct: 30, agencyPct: 20 };
  const [v, setV] = useState({ officerPct: String(d.officerPct), stationPct: String(d.stationPct), agencyPct: String(d.agencyPct) });
  const [err, setErr] = useState<string | null>(null);
  const total = Number(v.officerPct || 0) + Number(v.stationPct || 0) + Number(v.agencyPct || 0);
  const save = async () => {
    setErr(null);
    try {
      const r = await api<{ message: string }>(`/agencies/${agencyId}/donation-shares`, {
        method: 'PUT',
        body: JSON.stringify({ officerPct: Number(v.officerPct), stationPct: Number(v.stationPct), agencyPct: Number(v.agencyPct) }),
      });
      onSaved(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };
  const field = (k: keyof typeof v, label: string) => (
    <label className="field" style={{ marginBottom: 12 }}>
      <span>{label}</span>
      <input inputMode="decimal" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
    </label>
  );
  return (
    <section className="card" aria-labelledby="shares">
      <h2 id="shares" style={{ marginTop: 0 }}>
        How donations are shared
      </h2>
      {field('officerPct', 'Officer share of donations (%)')}
      {field('stationPct', 'Station share (%)')}
      {field('agencyPct', 'Agency share (%)')}
      <p className={total === 100 ? 'muted' : 'field-error'} style={{ marginTop: 0 }}>
        Total {total}%{total === 100 ? '' : ', must be 100%'}. Gifts to a named officer go to that officer. Used once donations launch.
      </p>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      <button className="btn" type="button" onClick={save} disabled={total !== 100}>
        Save shares
      </button>
    </section>
  );
}
