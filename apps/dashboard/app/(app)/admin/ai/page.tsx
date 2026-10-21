'use client';
// Board "Admin AI and LLM": where AI is used, which model runs it, the checks around it, cost, and
// the safety switches. AI suggests; a person decides.
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { naira } from '@/components/Dash';

interface Ai {
  settings: { provider: string; primary: string; fallback: string; region: string; paused: boolean; translationPaused: boolean; useFallback: boolean; monthlyLimitKobo: number; reviewBelowPct: number };
  stats: { requestsToday: number; failedToday: number; avgSeconds: number; briefSeconds: number; reviewPct: number; costMonthKobo: number; limitKobo: number };
  useCases: { code: string; name: string; model: string; mode: string; checkPct: number; status: 'live' | 'testing' | 'paused'; requests30d: number }[];
  languages: { code: string; name: string; status: string }[];
  perDay: { day: string; n: number }[];
  alerts: { tone: string; title: string; body: string }[];
  reviewWaiting: number;
}
interface Review {
  statementId: string;
  number: string;
  version: number;
  language: string;
  confidencePct: number;
  flagged: number;
  signedAt: string;
}
const STATUS_TONE: Record<string, string> = { live: 'var(--color-success-text)', testing: 'var(--color-warning-text)', paused: 'var(--color-text-secondary)' };
const RULES: [string, string][] = [
  ['Dispatch', 'AI suggests, a person sends'],
  ['Fines', 'A person decides, AI only flags'],
  ['KYC and bounty payment', 'A person approves'],
  ['Personal data', 'Names and numbers removed before sending'],
  ['Provider training on our data', 'Off, confirm in the contract'],
];
type Tab = 'overview' | 'use' | 'review' | 'usage' | 'safety';

export default function AiAdmin() {
  const [tab, setTab] = useState<Tab>('overview');
  const [ai, setAi] = useState<Ai | null>(null);
  const [queue, setQueue] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Ai>('/admin/ai')
      .then(setAi)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load AI settings.'));
    api<Review[]>('/admin/ai/reviews')
      .then(setQueue)
      .catch(() => setQueue([]));
  }, []);
  useEffect(load, [load]);
  const flip = async (b: Partial<Pick<Ai['settings'], 'paused' | 'translationPaused' | 'useFallback'>>) => {
    setBusy(true);
    try {
      setToast((await api<{ message: string }>('/admin/ai/switch', { method: 'POST', body: JSON.stringify(b) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not change it.');
    } finally {
      setBusy(false);
    }
  };
  const setUse = async (code: string, status: string) => {
    try {
      setToast((await api<{ message: string }>(`/admin/ai/use-cases/${code}`, { method: 'PUT', body: JSON.stringify({ status }) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not change it.');
    }
  };
  const s = ai?.settings;
  const max = Math.max(1, ...(ai?.perDay.map((d) => d.n) ?? [1]));
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>AI and LLM</h1>
          <p className="lede">Where AI is used, which model runs it, and the checks around it.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" href="/admin/audit?action=ai">
            Audit AI actions
          </Link>
          <button className={`btn ${s?.paused ? 'primary' : 'danger'}`} type="button" disabled={!s || busy} onClick={() => flip({ paused: !s!.paused })}>
            {s?.paused ? 'Turn AI back on' : 'Pause all AI'}
          </button>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {(
          [
            ['overview', 'Overview'],
            ['use', 'Use cases'],
            ['review', `Review queue${queue?.length ? ` ${queue.length}` : ''}`],
            ['usage', 'Usage and cost'],
            ['safety', 'Safety'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {ai && (tab === 'overview' || tab === 'usage') && (
        <div className="stats">
          <div className="stat">
            <span>AI requests today</span>
            <strong>{ai.stats.requestsToday}</strong>
            <small>{ai.stats.failedToday} failed</small>
          </div>
          <div className="stat">
            <span>Average time</span>
            <strong className="success">{ai.stats.avgSeconds} s</strong>
            <small>Briefing {ai.stats.briefSeconds ? `${ai.stats.briefSeconds} s` : 'not used yet'}</small>
          </div>
          <div className="stat">
            <span>Sent to human review</span>
            <strong className="warning">{ai.stats.reviewPct}%</strong>
            <small>Low confidence or flagged</small>
          </div>
          <div className="stat">
            <span>Cost this month</span>
            <strong className="info">{naira(ai.stats.costMonthKobo)}</strong>
            <small>Limit {naira(ai.stats.limitKobo)}</small>
          </div>
        </div>
      )}
      {ai && tab === 'overview' && ai.alerts.length > 0 && (
        <section className="card" aria-labelledby="al">
          <h2 id="al" style={{ marginTop: 0 }}>
            Alerts
          </h2>
          {ai.alerts.map((a) => (
            <div key={a.title} className={`banner ${a.tone}`} style={{ margin: '0 0 8px' }}>
              <strong style={{ display: 'block' }}>{a.title}</strong>
              {a.body}
            </div>
          ))}
        </section>
      )}
      {ai && (tab === 'overview' || tab === 'use') && (
        <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)' }}>
          <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="uc">
            <h2 id="uc" style={{ margin: 0, padding: '16px 16px 0' }}>
              Use cases
            </h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Use case</th>
                  <th>Model</th>
                  <th>Mode</th>
                  <th>Check rate</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ai.useCases.map((u) => (
                  <tr key={u.code}>
                    <td>
                      <strong>{u.name}</strong>
                      <div className="muted">{u.requests30d} in 30 days</div>
                    </td>
                    <td>{u.model}</td>
                    <td>{u.mode}</td>
                    <td>{u.checkPct}%</td>
                    <td>
                      {tab === 'use' ? (
                        <select value={u.status} onChange={(e) => setUse(u.code, e.target.value)} aria-label={`Status of ${u.name}`}>
                          <option value="live">Live</option>
                          <option value="testing">Testing</option>
                          <option value="paused">Paused</option>
                        </select>
                      ) : (
                        <strong style={{ color: STATUS_TONE[u.status] }}>{u.status[0]!.toUpperCase() + u.status.slice(1)}</strong>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card" aria-labelledby="rn">
            <h2 id="rn" style={{ marginTop: 0 }}>
              Rules that never change
            </h2>
            {RULES.map(([k, v]) => (
              <div className="row" key={k}>
                <span className="muted">{k}</span>
                <strong style={{ textAlign: 'right', color: k.startsWith('Provider') ? 'var(--color-success-text)' : undefined }}>{v}</strong>
              </div>
            ))}
          </section>
        </div>
      )}
      {ai && tab === 'overview' && (
        <div className="grid two">
          <ModelSettings ai={ai} onSaved={(m) => (setToast(m), load())} />
          <section className="card" aria-labelledby="lg">
            <h2 id="lg" style={{ marginTop: 0 }}>
              Languages
            </h2>
            {ai.languages.map((l) => (
              <div className="row" key={l.code}>
                <span>{l.name}</span>
                <strong style={{ color: l.status === 'good' ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{l.status === 'good' ? 'Good' : 'Test needed'}</strong>
              </div>
            ))}
            <div className="banner warning" style={{ margin: '8px 0 0' }}>
              <strong style={{ display: 'block' }}>Check accuracy before launch</strong>
              Run a test set per language. Statements below {ai.settings.reviewBelowPct}% confidence go to the review queue.
            </div>
          </section>
        </div>
      )}
      {tab === 'review' && (
        <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-label="Review queue">
          {!queue ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" />
            </div>
          ) : !queue.length ? (
            <div className="empty">Nothing to review. Translations below {ai?.settings.reviewBelowPct ?? 80}% confidence show here.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>Language</th>
                  <th>Confidence</th>
                  <th>Flagged words</th>
                  <th>Signed</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={`${r.statementId}:${r.version}`}>
                    <td>
                      <Link href={`/admin/ai/reviews/${r.statementId}`}>
                        <strong>
                          {r.number}, version {r.version}
                        </strong>
                      </Link>
                    </td>
                    <td>{r.language} to English</td>
                    <td style={{ color: 'var(--color-warning-text)', fontWeight: 700 }}>{r.confidencePct}%</td>
                    <td>{r.flagged}</td>
                    <td>{new Date(r.signedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {ai && (tab === 'overview' || tab === 'usage' || tab === 'safety') && (
        <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)' }}>
          {tab !== 'safety' ? (
            <section className="card" aria-labelledby="pd">
              <h2 id="pd" style={{ marginTop: 0 }}>
                Requests per day, last 14 days
              </h2>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 140, padding: '8px 0' }} role="img" aria-label={`Requests per day: ${ai.perDay.map((d) => d.n).join(', ')}`}>
                {ai.perDay.map((d) => (
                  <div key={d.day} title={`${d.day}: ${d.n}`} style={{ flex: 1, height: `${Math.max(3, (d.n / max) * 100)}%`, background: 'var(--color-signal)', borderRadius: '4px 4px 0 0' }} />
                ))}
              </div>
              <div className="muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span>{ai.perDay[0]?.day}</span>
                <span>Today</span>
              </div>
            </section>
          ) : (
            <span />
          )}
          <section className="card" aria-labelledby="ss">
            <h2 id="ss" style={{ marginTop: 0 }}>
              Safety switches
            </h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className={`btn ${ai.settings.paused ? 'primary' : 'danger'}`} type="button" disabled={busy} onClick={() => flip({ paused: !ai.settings.paused })}>
                {ai.settings.paused ? 'Turn AI back on' : 'Pause all AI'}
              </button>
              <button className="btn" type="button" disabled={busy} aria-pressed={ai.settings.translationPaused} onClick={() => flip({ translationPaused: !ai.settings.translationPaused })}>
                {ai.settings.translationPaused ? 'Resume translation' : 'Pause translation'}
              </button>
              <button className="btn" type="button" disabled={busy} aria-pressed={ai.settings.useFallback} onClick={() => flip({ useFallback: !ai.settings.useFallback })}>
                {ai.settings.useFallback ? 'Back to primary model' : 'Switch to fallback model'}
              </button>
            </div>
            <div className="banner info" style={{ margin: '12px 0 0' }}>
              <strong style={{ display: 'block' }}>What happens when paused</strong>
              Briefs fall back to the plain report. Statements are taken as audio and text and wait for translation.
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function ModelSettings({ ai, onSaved }: { ai: Ai; onSaved: (m: string) => void }) {
  const [f, setF] = useState({ provider: ai.settings.provider, primary: ai.settings.primary, fallback: ai.settings.fallback, region: ai.settings.region, limit: String(ai.settings.monthlyLimitKobo / 100) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      onSaved(
        (
          await api<{ message: string }>('/admin/ai/settings', {
            method: 'PUT',
            body: JSON.stringify({ provider: f.provider, primary: f.primary, fallback: f.fallback, region: f.region, monthlyLimitKobo: Math.round(Number(f.limit) * 100) }),
          })
        ).message,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      <input type="text" value={f[k]} onChange={(e) => setF({ ...f, [k]: k === 'limit' ? e.target.value.replace(/[^\d]/g, '') : e.target.value })} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
  return (
    <section className="card" aria-labelledby="ms">
      <h2 id="ms" style={{ marginTop: 0 }}>
        Model settings
      </h2>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '0 0 8px' }}>
          {err}
        </div>
      )}
      {field('provider', 'Provider')}
      {field('primary', 'Primary model')}
      {field('fallback', 'Fallback model', 'Used if the primary fails.')}
      {field('region', 'Data region', 'Choose a region that meets NDPA transfer rules.')}
      {field('limit', 'Monthly limit (₦)')}
      <button className="btn primary" type="button" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </section>
  );
}
