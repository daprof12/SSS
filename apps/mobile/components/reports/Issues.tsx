'use client';

import { LinkButton } from '@erp/web-ui/LinkButton';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, uid } from '@/lib/client';
import { AddFiles, AttachPicker, Attachments, uploadPicked, usePicked } from './Attach';
import { WherePicker, whereBody, type Where } from './WherePicker';

interface Cat {
  code: string;
  label: string;
  icon: string;
  subtypes: string[];
  urgent: boolean;
  agencyLabel: string;
  joined: boolean;
}

/** Board "Public issue pick category". */
export function IssueCategories({ base, back }: { base: string; back: string }) {
  const [cats, setCats] = useState<Cat[] | null>(null);
  useEffect(() => {
    api<Cat[]>('/issues/categories').then(setCats).catch(() => setCats([]));
  }, []);
  return (
    <main className="app bare">
      <Header title="Report a public issue" back={back} />
      <p className="muted" style={{ marginTop: -8 }}>
        For problems in your area that are not an emergency. Pick one.
      </p>
      {!cats && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
      <div style={{ display: 'grid', gap: 10 }}>
        {cats?.map((c) => (
          <Link key={c.code} href={`${base}/new/${c.code}`} className="tile" style={{ placeItems: 'start', textAlign: 'left', minHeight: 96, padding: '16px 20px' }}>
            <Icon name={c.icon} size={28} />
            <span style={{ fontSize: 'var(--text-md)' }}>{c.label}</span>
            <span className="muted" style={{ fontWeight: 400 }}>
              Goes to {c.agencyLabel}
              {c.urgent ? ' · treated as urgent' : ''}
            </span>
          </Link>
        ))}
      </div>
    </main>
  );
}

const SEVERITY: Array<[string, string]> = [
  ['small', 'Small'],
  ['dangerous', 'Dangerous'],
  ['blocking', 'Blocking the way'],
];

/** Board "Public issue road form": where (auto from GPS), what, how bad, words, count banner, anonymity. */
export function IssueForm({ category, base, sosHref }: { category: string; base: string; sosHref: string }) {
  const router = useRouter();
  const [cat, setCat] = useState<Cat | null>(null);
  const [where, setWhere] = useState<Where | null>(null);
  const [subtype, setSubtype] = useState('');
  const [severity, setSeverity] = useState('');
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [nearby, setNearby] = useState<{ reports: number; people: number } | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(uid());
  const picked = usePicked();
  const [stage, setStage] = useState<'sending' | 'uploading' | null>(null);

  useEffect(() => {
    api<Cat[]>('/issues/categories').then((cs) => setCat(cs.find((c) => c.code === category) ?? null));
  }, [category]);

  // Live count for this spot: "[n] people already reported this".
  useEffect(() => {
    if (!where || where.kind === 'none') return setNearby(null);
    const q = new URLSearchParams({ category, ...Object.fromEntries(Object.entries(whereBody(where)).map(([k, v]) => [k, String(v)])) });
    api<{ reports: number; people: number } | null>(`/issues/nearby?${q}`)
      .then(setNearby)
      .catch(() => setNearby(null));
  }, [where, category]);

  const send = async () => {
    const e: Record<string, string> = {};
    if (!where || where.kind === 'none') e.where = 'Add where it is: your location or a postcode.';
    if (!subtype) e.subtype = 'Choose what it is.';
    if (!severity) e.severity = 'Choose how bad it is.';
    if (text.trim().length < 10 && !picked.items.length) e.description = 'Photo or a few words needed so the team can find it.';
    setErrs(e);
    if (Object.keys(e).length) return requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-invalid="true"] input, [data-invalid="true"] textarea, [data-invalid="true"] button')?.focus());
    setBusy(true);
    setStage('sending');
    try {
      const r = await api<{ id: string; joined: boolean; already: boolean; urgent: boolean }>('/issues', {
        method: 'POST',
        body: JSON.stringify({ category, subtype, severity, description: text.trim(), withMedia: picked.items.length > 0, anonymous, clientRef: clientRef.current, ...whereBody(where!) }),
      });
      // The report is in; files follow. A failed file never loses the report.
      let failed = 0;
      if (picked.items.length) {
        setStage('uploading');
        failed = await uploadPicked('issue_case', r.id, picked);
      }
      router.replace(`${base}/${r.id}?sent=${r.already ? 'again' : r.joined ? 'joined' : 'new'}${r.urgent ? '&urgent=1' : ''}${failed ? `&files=${failed}` : ''}`);
    } catch (x) {
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not send. Try again.' });
      setBusy(false);
      setStage(null);
    }
  };

  if (!cat) return <main className="app bare"><div className="skeleton" style={{ height: 300 }} /></main>;
  return (
    <main className="app bare">
      <Header title={cat.label} back={`${base}/new`} />
      {cat.urgent && (
        <div className="banner critical">
          <strong>If someone is in danger now, use SOS</strong>
          <Link href={sosHref}>Open SOS</Link>
        </div>
      )}
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}
      <WherePicker value={where} onChange={setWhere} error={errs.where} autoLocate />

      <p className="section-label">What is it</p>
      <div className="field" data-invalid={!!errs.subtype} style={{ marginBottom: 12 }}>
        <div className="chips" role="radiogroup" aria-label="What is it">
          {cat.subtypes.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={subtype === s} aria-pressed={subtype === s} onClick={() => setSubtype(s)}>
              {s}
            </button>
          ))}
        </div>
        {errs.subtype && <span className="field-error">{errs.subtype}</span>}
      </div>

      <p className="section-label">How bad</p>
      <div className="field" data-invalid={!!errs.severity} style={{ marginBottom: 12 }}>
        <div className="chips" role="radiogroup" aria-label="How bad">
          {SEVERITY.map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={severity === k} aria-pressed={severity === k} onClick={() => setSeverity(k)}>
              {l}
            </button>
          ))}
        </div>
        {errs.severity && <span className="field-error">{errs.severity}</span>}
      </div>

      <AttachPicker picked={picked} disabled={busy} />

      <label className="field" data-invalid={!!errs.description}>
        <span>Tell us more</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} aria-invalid={!!errs.description} placeholder={picked.items.length ? 'Optional with a photo' : 'A few words so the team can find it'} />
        {errs.description && <span className="field-error">{errs.description}</span>}
      </label>

      {nearby && (
        <div className="banner info" role="status">
          <strong>
            {nearby.people} {nearby.people === 1 ? 'person has' : 'people have'} already reported this
          </strong>
          Your report adds to the count, so {cat.agencyLabel} sees how many people need this fixed. No fine for joining a report.
        </div>
      )}

      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Send without my name</strong>
            <span className="sub">The agency sees the report, not who sent it</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={anonymous} aria-label="Send without my name" onClick={() => setAnonymous((v) => !v)} />
        </div>
      </div>
      <button className="btn block primary" type="button" onClick={send} disabled={busy}>
        {stage === 'uploading' ? 'Sending photos…' : busy ? 'Sending…' : nearby ? 'Add my report' : 'Send report'}
      </button>
    </main>
  );
}

interface Detail {
  publicNo: string;
  category: string;
  agency: string;
  agencyJoined: boolean;
  place: string;
  state: string;
  status: { title: string; line: string; step: number };
  severity: string;
  reports: number;
  people: number;
  targetOn: string | null;
  fixNote: string | null;
  mine: { subtype: string | null; description: string | null; anonymous: boolean; vote: string | null };
  canVote: boolean;
  timeline: Array<{ label: string; note: string | null; at: string }>;
}

const STEPS = ['Sent', 'Taken on', 'Work started', 'Fix reported', 'Fixed'];
const when = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** Case status with the reporters' "Is it fixed?" check (Report Tracking B3). */
export function IssueDetail({ id, back, sosHref }: { id: string; back: string; sosHref: string }) {
  const params = useSearchParams();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const [files, setFiles] = useState(0);

  const load = useCallback(() => api<Detail>(`/issues/${id}`).then(setD).catch((e: ApiError) => setErr(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const s = params.get('sent');
    if (params.get('files')) setToast('Report sent, but some files did not upload. Add them again below.');
    else if (s) setToast(s === 'joined' ? 'Added to the existing report.' : s === 'again' ? 'You already reported this. We added your new details.' : 'Report sent. Thank you.');
  }, [params, setToast]);

  const vote = async (v: 'yes' | 'no') => {
    setBusy(true);
    try {
      const r = await api<{ state: string }>(`/issues/${id}/vote`, { method: 'POST', body: JSON.stringify({ vote: v }) });
      setToast(r.state === 'fixed' ? 'Marked fixed. Thank you.' : r.state === 'reopened' ? 'Reopened. The agency has been told.' : 'Thanks. Waiting for others to confirm.');
      void load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };

  if (err) return <main className="app bare"><Header back={back} /><div className="card empty"><strong>{err}</strong></div></main>;
  if (!d) return <main className="app bare">{[0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 100 }} />)}</main>;

  return (
    <main className="app bare">
      <Header title={d.category} back={back}>
        <span className={`chip ${d.state === 'fixed' ? 'success' : d.state === 'awaiting_check' ? 'warning' : 'info'}`}>{d.status.title}</span>
      </Header>
      {params.get('urgent') && (
        <div className="banner critical">
          <strong>If anyone is in danger now, use SOS</strong>
          <Link href={sosHref}>Open SOS</Link>
        </div>
      )}
      <p style={{ margin: '0 0 4px', fontWeight: 600 }}>{d.status.line}</p>
      <p className="muted" style={{ marginTop: 0 }}>
        {d.publicNo} · {d.place}
      </p>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="big-number" style={{ fontSize: 36 }}>
            {d.people}
          </span>
          <span className="muted">{d.people === 1 ? 'person reported this' : 'people reported this'}</span>
        </div>
        <span className="muted">The count shows {d.agency} how many people need it fixed.</span>
      </div>

      <div className="card">
        <ol className="steps" style={{ gridTemplateColumns: '1fr', margin: 0 }}>
          {STEPS.map((s, i) => (
            <li key={s} className={i < d.status.step || d.state === 'fixed' ? 'done' : i === d.status.step ? 'now' : ''}>
              <i aria-hidden />
              {s}
              {i === 1 && d.targetOn ? <span className="muted" style={{ marginLeft: 'auto' }}>target {when(d.targetOn)}</span> : null}
            </li>
          ))}
        </ol>
      </div>
      {!d.agencyJoined && <div className="banner info">{d.agency} has not joined yet. Our team holds the report and passes it on.</div>}

      {d.canVote && (
        <div className="card">
          <h2>Is it fixed?</h2>
          {d.fixNote && <p className="muted" style={{ marginTop: 0 }}>{d.agency}: “{d.fixNote}”</p>}
          <div className="btn-row">
            <button className="btn signal" type="button" disabled={busy} onClick={() => vote('yes')}>
              Yes, it is fixed
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => vote('no')}>
              No, still there
            </button>
          </div>
        </div>
      )}
      {d.mine.vote && d.state === 'awaiting_check' && <div className="banner success">You said it is fixed. Waiting for others to confirm.</div>}

      <p className="section-label">Your report</p>
      <div className="card">
        <strong>{d.mine.subtype ?? d.category}</strong>
        <p className="muted" style={{ margin: '4px 0 0' }}>{d.mine.description}</p>
        <p className="muted" style={{ margin: '8px 0 0' }}>{d.mine.anonymous ? 'Sent without your name.' : 'Sent with your name.'}</p>
      </div>
      <Attachments ownerType="issue_case" ownerId={id} refreshKey={files} />
      {d.state !== 'fixed' && (
        <AddFiles
          ownerType="issue_case"
          ownerId={id}
          onDone={(n) => {
            setFiles((k) => k + 1);
            setToast(n === 1 ? 'Photo added to the report.' : 'Files added to the report.');
          }}
        />
      )}

      <p className="section-label">History</p>
      <div className="list">
        {[...d.timeline].reverse().map((e, i) => (
          <div key={i} className="row" style={{ cursor: 'default', minHeight: 52 }}>
            <span className="grow">
              {e.label}
              {e.note && <span className="sub">“{e.note}”</span>}
            </span>
            <span className="end">{when(e.at)}</span>
          </div>
        ))}
      </div>
      <Toast msg={toast} />
    </main>
  );
}

interface Mine {
  id: string;
  publicNo: string;
  category: string;
  state: string;
  status: { title: string };
  people: number;
  postcode: string | null;
}

export function IssuesList({ base, back }: { base: string; back: string | false }) {
  const [rows, setRows] = useState<Mine[] | null>(null);
  useEffect(() => {
    api<Mine[]>('/me/issues').then(setRows).catch(() => setRows([]));
  }, []);
  return (
    <main className="app">
      <Header title="My public issues" back={back} />
      {!rows && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {rows?.length === 0 && (
        <div className="empty">
          <strong>Nothing reported yet.</strong>
          Bad roads, broken lights, waste: report it and follow it until it is fixed.
        </div>
      )}
      {rows?.map((r) => (
        <Link key={r.id} href={`${base}/${r.id}`} className={`inc sev-${r.state === 'fixed' ? 'success' : r.state === 'awaiting_check' ? 'warning' : 'info'}`}>
          <span className="grow">
            <strong style={{ textTransform: 'none' }}>{r.category}</strong>
            <span className="sub">
              {r.postcode ?? 'GPS'} · {r.people} {r.people === 1 ? 'person' : 'people'}
            </span>
          </span>
          <span className={`chip ${r.state === 'fixed' ? 'success' : r.state === 'awaiting_check' ? 'warning' : 'info'}`}>{r.status.title}</span>
        </Link>
      ))}
      <LinkButton href={`${base}/new`} className="btn block primary" style={{ marginTop: 12 }}>
        <Icon name="road" /> Report a problem
      </LinkButton>
    </main>
  );
}
