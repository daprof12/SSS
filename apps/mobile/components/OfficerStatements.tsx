'use client';
// Officer app statements (B7, traditional statement processing, digitised): ask anyone on the report
// for a statement, write your own officer's statement, or take one down in person at the scene and
// have the person confirm it with a code sent to their phone.
import { STATEMENT_CAUTION, STATEMENT_LANGUAGES, STATEMENT_ROLES, STATEMENT_RULES } from '@erp/domain';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/client';
import { Icon } from './Icon';

interface Row {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  form: string;
  maker: string;
  mode: 'self' | 'in_person';
  versions: number;
}
interface Party {
  userId: string;
  name: string;
  role: string;
  roleLabel: string;
  isMe: boolean;
  statement: { id: string; number: string } | null;
}

/** Statements card on the officer's incident screen. */
export function IncidentStatements({ id, state, onToast, refresh }: { id: string; state: string; onToast: (m: string) => void; refresh: number }) {
  const [list, setList] = useState<Row[] | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => {
    api<Row[]>(`/incidents/${id}/statements`)
      .then(setList)
      .catch(() => setList([]));
  }, [id]);
  useEffect(load, [load, refresh]);
  if (!list) return null;
  const open = !['pending_cancel', 'cancelled', 'merged'].includes(state);
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ flex: 1 }}>Statements</strong>
        {open && (
          <button className="btn small" type="button" onClick={() => setAsking(true)}>
            Add statement
          </button>
        )}
      </div>
      {!list.length && <p className="muted" style={{ margin: '6px 0 0', fontSize: 'var(--text-sm)' }}>Ask the reporter, a witness, a victim or a suspect, or write your own officer&apos;s statement.</p>}
      {list.map((x) => (
        <Link key={x.id} href={`/officer/statements/${x.id}`} className="row" style={{ padding: 0, minHeight: 52 }}>
          <span className="grow">
            <strong>
              {x.form}: {x.maker}
            </strong>
            <span className="sub">
              {x.number}
              {x.mode === 'in_person' ? ', in person' : ''}, {x.versions && x.state === 'signed' ? `signed, version ${x.versions}` : x.stateLabel === 'Waiting for you' ? 'waiting' : x.stateLabel.toLowerCase()}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
      ))}
      {asking && (
        <AskSheet
          incidentId={id}
          onClose={() => setAsking(false)}
          onDone={(m) => {
            setAsking(false);
            onToast(m);
            load();
          }}
        />
      )}
    </div>
  );
}

function AskSheet({ incidentId, onClose, onDone }: { incidentId: string; onClose: () => void; onDone: (m: string) => void }) {
  const router = useRouter();
  const [parties, setParties] = useState<Party[] | null>(null);
  const [who, setWho] = useState('');
  const [role, setRole] = useState('witness');
  const [phone, setPhone] = useState('+234');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'self' | 'in_person'>('in_person');
  const [presentName, setPresentName] = useState('');
  const [presentRelation, setPresentRelation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ parties: Party[] }>(`/incidents/${incidentId}/statement-parties`)
      .then((r) => {
        setParties(r.parties);
        setWho(r.parties.find((x) => !x.statement)?.userId ?? 'other');
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load who is on the report.'));
  }, [incidentId]);
  const party = parties?.find((x) => x.userId === who);
  const effRole = party ? party.role : role;
  const suspect = effRole === 'suspect';
  const effMode = suspect ? 'in_person' : party?.isMe ? 'self' : mode;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string; mode: string; message: string }>(`/incidents/${incidentId}/statements`, {
        method: 'POST',
        body: JSON.stringify({
          ...(party ? { userId: party.userId } : { phone: phone.replace(/\s+/g, ''), name: name.trim() || undefined }),
          role: effRole,
          mode: effMode,
          presentName: presentName.trim() || undefined,
          presentRelation: presentRelation.trim() || undefined,
          place: 'At the scene',
        }),
      });
      onDone(r.message);
      if (party?.isMe) router.push(`/officer/statements/${r.id}/write`);
      else if (r.mode === 'in_person') router.push(`/officer/statements/${r.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not start it. Try again.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Add a statement"
      description="From anyone on the report. They write and sign it on their phone, or you take it down now and they confirm with a code."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy || !parties}>
            {party?.isMe ? 'Write my statement' : effMode === 'in_person' ? 'Start taking it' : 'Send request'}
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      {!parties && !err && <div className="skeleton" />}
      {parties && (
        <div className="chips" role="group" aria-label="Who" style={{ flexWrap: 'wrap' }}>
          {parties.map((x) => (
            <button key={x.userId} type="button" aria-pressed={who === x.userId} disabled={!!x.statement} onClick={() => setWho(x.userId)}>
              {x.isMe ? 'Me' : x.name}, {x.roleLabel.toLowerCase()}
              {x.statement ? ' (asked)' : ''}
            </button>
          ))}
          <button type="button" aria-pressed={who === 'other'} onClick={() => setWho('other')}>
            Someone else
          </button>
        </div>
      )}
      {who === 'other' && (
        <>
          <label className="field">
            <span>They are the</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {STATEMENT_ROLES.filter((r) => r.code !== 'officer').map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Their phone</span>
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="field">
            <span>Full name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
        </>
      )}
      {!suspect && !party?.isMe && (
        <div className="segmented" role="group" aria-label="How">
          <button type="button" aria-pressed={mode === 'in_person'} onClick={() => setMode('in_person')}>
            Take it now
          </button>
          <button type="button" aria-pressed={mode === 'self'} onClick={() => setMode('self')}>
            On their phone
          </button>
        </div>
      )}
      {suspect && <div className="banner warning">Cautionary statement: read the caution first. They may have a lawyer or a person of their choice present.</div>}
      {effMode === 'in_person' && !party?.isMe && (
        <>
          <label className="field">
            <span>Person present{suspect ? '' : ' (optional)'}</span>
            <input value={presentName} onChange={(e) => setPresentName(e.target.value)} maxLength={120} placeholder="Full name" />
          </label>
          <label className="field">
            <span>Their relation</span>
            <input value={presentRelation} onChange={(e) => setPresentRelation(e.target.value)} maxLength={80} placeholder="Lawyer, parent, friend…" />
          </label>
        </>
      )}
    </Sheet>
  );
}

export interface InPersonView {
  id: string;
  maker: string;
  caution: { text: string; givenAt: string | null } | null;
  present: { name: string; relation: string | null } | null;
  codeSentTo: string | null;
  makerHasPhone: boolean;
  draft: { language: string | null; original: string | null; english: string | null; confidence: number | null; flagged: string[] } | null;
}

/** At the scene: write it down, read it back, they read out the code sent to their phone. */
export function TakeInPerson({ v, onChange, onToast }: { v: InPersonView; onChange: () => void; onToast: (m: string) => void }) {
  const [lang, setLang] = useState(v.draft?.language ?? 'auto');
  const [original, setOriginal] = useState(v.draft?.original ?? '');
  const [english, setEnglish] = useState(v.draft?.english ?? '');
  const [code, setCode] = useState('');
  const [readBack, setReadBack] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setEnglish(v.draft?.english ?? ''), [v.draft?.english]);
  const call = async (key: string, path: string, method: string, body?: object) => {
    setBusy(key);
    setErr(null);
    try {
      const r = await api<{ message?: string }>(`/statements/${v.id}/in-person/${path}`, { method, body: body ? JSON.stringify(body) : '{}' });
      if (r.message) onToast(r.message);
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not save. Try again.');
    } finally {
      setBusy(null);
    }
  };
  const needsCaution = !!v.caution && !v.caution.givenAt;
  const saved = (v.draft?.original ?? '') === original.trim() && !!v.draft?.english;
  return (
    <>
      {v.caution && (
        <div className={`banner ${needsCaution ? 'warning' : 'info'}`}>
          <strong>{needsCaution ? 'Read this caution to them first' : 'Caution read'}</strong>“{STATEMENT_CAUTION}”
          {needsCaution && (
            <button className="btn small" type="button" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => call('caution', 'caution', 'POST')}>
              I have read it to them
            </button>
          )}
        </div>
      )}
      {v.present && (
        <p className="muted">
          Present: {v.present.name}
          {v.present.relation ? `, ${v.present.relation.toLowerCase()}` : ''}
        </p>
      )}
      {err && <div className="banner critical">{err}</div>}
      <label className="field">
        <span>Language they speak</span>
        <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={needsCaution}>
          {STATEMENT_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Their words, exactly as said</span>
        <textarea rows={7} value={original} onChange={(e) => setOriginal(e.target.value)} maxLength={STATEMENT_RULES.maxChars} disabled={needsCaution} />
      </label>
      <button className="btn" type="button" disabled={!!busy || needsCaution || original.trim().length < STATEMENT_RULES.minChars} onClick={() => call('save', 'draft', 'PUT', { language: lang, original })}>
        {busy === 'save' ? 'Making the English record…' : 'Save and make the English record'}
      </button>
      {v.draft?.english && (
        <>
          <label className="field" style={{ marginTop: 12 }}>
            <span>English record (check it with them)</span>
            <textarea rows={6} value={english} onChange={(e) => setEnglish(e.target.value)} />
          </label>
          {english !== v.draft.english && (
            <button className="btn" type="button" disabled={!!busy} onClick={() => call('eng', 'draft', 'PUT', { language: v.draft?.language ?? lang, original, english })}>
              Save the corrected English
            </button>
          )}
        </>
      )}
      <label className="row" style={{ marginTop: 12 }}>
        <span className="grow">I read it back and they agreed with it</span>
        <input type="checkbox" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} />
      </label>
      <div className="btn-row">
        <button className="btn" type="button" disabled={!!busy || !saved || needsCaution || !v.makerHasPhone} onClick={() => call('code', 'send-code', 'POST')}>
          {v.codeSentTo ? 'New code' : 'Send code to their phone'}
        </button>
      </div>
      {v.codeSentTo && (
        <>
          <label className="field">
            <span>Code they read out (sent to {v.codeSentTo})</span>
            <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </label>
          <button className="btn primary" type="button" disabled={!!busy || code.length !== 6 || !readBack} onClick={() => call('confirm', 'confirm', 'POST', { code, confirm: readBack })}>
            {busy === 'confirm' ? 'Sealing…' : 'Confirm and seal'}
          </button>
        </>
      )}
      {!v.makerHasPhone && <p className="field-error">This person has no phone on record, so they cannot confirm with a code.</p>}
    </>
  );
}
