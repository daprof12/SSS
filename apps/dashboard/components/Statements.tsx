'use client';
// Statements on a report (B7, traditional statement processing, digitised): from the complainant,
// a victim, a witness, a suspect (cautionary statement) or an officer. The person writes it on their
// phone and signs with their PIN, or an officer takes it in person and the person confirms it with a
// code sent to their phone. Used by the station and agency dashboards.
import { STATEMENT_CAUTION, STATEMENT_LANGUAGES, STATEMENT_ROLES, STATEMENT_RULES } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

interface Row {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  role: string;
  form: string;
  maker: string;
  mode: 'self' | 'in_person';
  versions: number;
  signedAt: string | null;
}
interface Party {
  userId: string;
  name: string;
  role: string;
  roleLabel: string;
  isMe: boolean;
  hasPhone: boolean;
  statement: { id: string; number: string; state: string } | null;
}

/** "Statements" card on a report: everyone asked so far, and "Ask for a statement". */
export function StatementsCard({ incidentId, state, onDone }: { incidentId: string; state: string; onDone: (m: string) => void }) {
  const [list, setList] = useState<Row[] | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => {
    api<Row[]>(`/incidents/${incidentId}/statements`)
      .then(setList)
      .catch(() => setList([]));
  }, [incidentId]);
  useEffect(load, [load, state]);
  if (!list) return null;
  const closed = ['pending_cancel', 'cancelled', 'merged'].includes(state);
  return (
    <section className="card" aria-labelledby="stmt">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h2 id="stmt" style={{ margin: 0 }}>
          Statements
        </h2>
        {!closed && (
          <button className="btn small" type="button" onClick={() => setAsking(true)}>
            Ask for a statement
          </button>
        )}
      </div>
      {!list.length && <p className="muted">No statements yet. Ask the reporter, a witness, a victim, a suspect or an officer on the report.</p>}
      {list.map((s) => (
        <Link className="row" key={s.id} href={`/statements/${s.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="label">
            <strong>
              {s.form}: {s.maker}
            </strong>
            <span>
              {s.number}
              {s.mode === 'in_person' ? ', taken in person' : ''}
              {s.versions ? `, signed, version ${s.versions}` : `, ${s.stateLabel === 'Waiting for you' ? 'waiting for them' : s.stateLabel.toLowerCase()}`}
            </span>
          </div>
          <span className={`chip ${s.versions && s.state === 'signed' ? 'success' : 'warning'}`}>{s.versions && s.state === 'signed' ? 'Signed' : 'Waiting'}</span>
        </Link>
      ))}
      {asking && (
        <AskStatementSheet
          incidentId={incidentId}
          onClose={() => setAsking(false)}
          onDone={(m) => {
            setAsking(false);
            onDone(m);
            load();
          }}
        />
      )}
    </section>
  );
}

/** Who to ask, how (on their phone or in person), and for a suspect, who is present. */
export function AskStatementSheet({ incidentId, onClose, onDone }: { incidentId: string; onClose: () => void; onDone: (m: string) => void }) {
  const router = useRouter();
  const [parties, setParties] = useState<Party[] | null>(null);
  const [who, setWho] = useState<string>('');
  const [role, setRole] = useState('witness');
  const [phone, setPhone] = useState('+234');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'self' | 'in_person'>('self');
  const [presentName, setPresentName] = useState('');
  const [presentRelation, setPresentRelation] = useState('');
  const [place, setPlace] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
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
    setFields({});
    try {
      const body = {
        ...(party ? { userId: party.userId } : { phone: phone.replace(/\s+/g, ''), name: name.trim() || undefined }),
        role: effRole,
        mode: effMode,
        note: note.trim() || undefined,
        presentName: presentName.trim() || undefined,
        presentRelation: presentRelation.trim() || undefined,
        place: place.trim() || undefined,
      };
      const r = await api<{ id: string; mode: string; message: string }>(`/incidents/${incidentId}/statements`, { method: 'POST', body: JSON.stringify(body) });
      onDone(r.message);
      if (r.mode === 'in_person') router.push(`/statements/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setErr(e.message);
        setFields(Object.fromEntries((e.fields ?? []).map((f) => [f.field, f.message])));
      } else setErr('Could not ask. Try again.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Ask for a statement"
      description="Anyone on the report can give one. They write it in their own language and sign it, or you take it down in person."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy || !parties}>
            {effMode === 'in_person' ? 'Start taking it' : party?.isMe ? 'Write my statement' : 'Send request'}
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
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Who</legend>
          <div style={{ display: 'grid', gap: 6 }}>
            {parties.map((x) => (
              <button key={x.userId} type="button" className="choice-card" aria-pressed={who === x.userId} disabled={!!x.statement} onClick={() => setWho(x.userId)} style={{ opacity: x.statement ? 0.55 : 1 }}>
                <strong>{x.isMe ? `${x.name} (you)` : x.name}</strong>{' '}
                <span className="muted">
                  {x.roleLabel}
                  {x.statement ? `, already asked (${x.statement.number})` : ''}
                </span>
              </button>
            ))}
            <button type="button" className="choice-card" aria-pressed={who === 'other'} onClick={() => setWho('other')}>
              <strong>Someone else</strong> <span className="muted">A victim, witness or suspect, by phone number</span>
            </button>
          </div>
        </fieldset>
      )}
      {who === 'other' && (
        <>
          <label className="field">
            <span>They are the</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {STATEMENT_ROLES.filter((r) => r.code !== 'officer').map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label} ({r.form.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          <label className="field" data-invalid={!!fields.phone}>
            <span>Phone</span>
            <input type="text" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2348012345678" />
            {fields.phone && <span className="field-error">{fields.phone}</span>}
          </label>
          <label className="field" data-invalid={!!fields.name}>
            <span>Full name (if they are not on the app yet)</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            {fields.name && <span className="field-error">{fields.name}</span>}
          </label>
        </>
      )}
      {!suspect && !party?.isMe && (
        <div className="segmented" role="group" aria-label="How">
          <button type="button" aria-pressed={mode === 'self'} onClick={() => setMode('self')}>
            They write it on their phone
          </button>
          <button type="button" aria-pressed={mode === 'in_person'} onClick={() => setMode('in_person')}>
            Take it now, in person
          </button>
        </div>
      )}
      {suspect && (
        <div className="banner warning" style={{ margin: 0 }}>
          <strong style={{ display: 'block' }}>Cautionary statement, taken in person</strong>
          Read them the caution first. They may have a lawyer or a person of their choice present.
        </div>
      )}
      {effMode === 'in_person' && (
        <>
          <label className="field" data-invalid={!!fields.presentName}>
            <span>Person present{suspect ? '' : ' (optional)'}</span>
            <input type="text" value={presentName} onChange={(e) => setPresentName(e.target.value)} maxLength={120} placeholder="Full name" />
            {fields.presentName && <span className="field-error">{fields.presentName}</span>}
          </label>
          <label className="field">
            <span>Their relation</span>
            <input type="text" value={presentRelation} onChange={(e) => setPresentRelation(e.target.value)} maxLength={80} placeholder="Lawyer, parent, friend…" />
          </label>
          <label className="field">
            <span>Where it is taken</span>
            <input type="text" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={160} placeholder="Station 4 Ikeja, interview room" />
          </label>
        </>
      )}
      {effMode === 'self' && !party?.isMe && (
        <label className="field">
          <span>What you need from them (optional)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="For example, what you saw from the window." />
        </label>
      )}
    </Sheet>
  );
}

export interface StatementView {
  id: string;
  number: string;
  state: string;
  role: string;
  form: string;
  mode: 'self' | 'in_person';
  maker: string;
  caution: { text: string; givenAt: string | null } | null;
  present: { name: string; relation: string | null } | null;
  place: string | null;
  takenBy: string | null;
  codeSentTo: string | null;
  makerHasPhone: boolean;
  draft: { language: string | null; original: string | null; english: string | null; confidence: number | null; flagged: string[] } | null;
}

/** Taking a statement in person: write what they say, read it back, then they confirm with a code. */
export function TakeInPerson({ v, onChange, onToast }: { v: StatementView; onChange: () => void; onToast: (m: string) => void }) {
  const [lang, setLang] = useState(v.draft?.language ?? 'auto');
  const [original, setOriginal] = useState(v.draft?.original ?? '');
  const [english, setEnglish] = useState(v.draft?.english ?? '');
  const [code, setCode] = useState('');
  const [readBack, setReadBack] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setEnglish(v.draft?.english ?? '');
  }, [v.draft?.english]);
  const call = async (key: string, path: string, method: string, body?: object) => {
    setBusy(key);
    setErr(null);
    try {
      const r = await api<{ message?: string }>(`/statements/${v.id}/in-person/${path}`, { method, body: body ? JSON.stringify(body) : '{}' });
      if (r.message) onToast(r.message);
      onChange();
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not save. Try again.');
      return false;
    } finally {
      setBusy(null);
    }
  };
  const saved = (v.draft?.original ?? '') === original.trim() && !!v.draft?.english;
  const short = original.trim().length < STATEMENT_RULES.minChars;
  const needsCaution = !!v.caution && !v.caution.givenAt;
  return (
    <section className="card" aria-labelledby="take">
      <h2 id="take" style={{ marginTop: 0 }}>
        Take it down in person
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {v.maker} speaks; you write exactly what they say in their language. The English record is made for you to check with them.
        {v.present ? ` Present: ${v.present.name}${v.present.relation ? `, ${v.present.relation.toLowerCase()}` : ''}.` : ''}
        {v.place ? ` At ${v.place}.` : ''}
      </p>
      {v.caution && (
        <div className={`banner ${v.caution.givenAt ? 'info' : 'warning'}`} style={{ margin: '0 0 12px' }}>
          <strong style={{ display: 'block' }}>{v.caution.givenAt ? 'Caution read' : 'Read this caution first'}</strong>“{v.caution.text}”
          {!v.caution.givenAt && (
            <div style={{ marginTop: 8 }}>
              <button className="btn small" type="button" disabled={!!busy} onClick={() => call('caution', 'caution', 'POST')}>
                I have read the caution to them
              </button>
            </div>
          )}
        </div>
      )}
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '0 0 12px' }}>
          {err}
        </div>
      )}
      <div className="grid two" style={{ margin: 0 }}>
        <div>
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
            <textarea value={original} onChange={(e) => setOriginal(e.target.value)} maxLength={STATEMENT_RULES.maxChars} rows={10} disabled={needsCaution} />
            <small className="muted">{short ? `At least ${STATEMENT_RULES.minChars} characters.` : `${original.length} characters`}</small>
          </label>
          <button className="btn" type="button" disabled={!!busy || short || needsCaution} onClick={() => call('save', 'draft', 'PUT', { language: lang, original })}>
            {busy === 'save' ? 'Making the English record…' : 'Save and make the English record'}
          </button>
        </div>
        <div>
          <label className="field">
            <span>English record (correct it with them)</span>
            <textarea value={english} onChange={(e) => setEnglish(e.target.value)} rows={10} disabled={!v.draft?.english} />
            {v.draft?.confidence != null && (
              <small className="muted">
                AI confidence {Math.round(v.draft.confidence * 100)}%{v.draft.flagged.length ? `. Check: ${v.draft.flagged.join(', ')}` : ''}
              </small>
            )}
          </label>
          {v.draft?.english && english !== v.draft.english && (
            <button className="btn" type="button" disabled={!!busy} onClick={() => call('eng', 'draft', 'PUT', { language: v.draft?.language ?? lang, original, english })}>
              Save the corrected English
            </button>
          )}
        </div>
      </div>
      <div className="banner info" style={{ margin: '12px 0' }}>
        <strong style={{ display: 'block' }}>Read it back to them</strong>
        Then send a code to their phone. They read the code to you only if it is what they said. That seals it; no one can edit it after.
      </div>
      <label className="row" style={{ cursor: 'pointer' }}>
        <span>I read the statement back to them and they agreed with it</span>
        <input type="checkbox" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} />
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginTop: 8 }}>
        <button className="btn" type="button" disabled={!!busy || !saved || needsCaution || !v.makerHasPhone} onClick={() => call('code', 'send-code', 'POST')}>
          {v.codeSentTo ? 'Send a new code' : 'Send code to their phone'}
        </button>
        {v.codeSentTo && (
          <>
            <label className="field" style={{ margin: 0 }}>
              <span>Code they read out (sent to {v.codeSentTo})</span>
              <input type="text" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ width: 140 }} />
            </label>
            <button className="btn primary" type="button" disabled={!!busy || code.length !== 6 || !readBack} onClick={() => call('confirm', 'confirm', 'POST', { code, confirm: readBack })}>
              {busy === 'confirm' ? 'Sealing…' : 'Confirm and seal'}
            </button>
          </>
        )}
      </div>
      {!v.makerHasPhone && <p className="field-error">This person has no phone number on record, so they cannot confirm with a code.</p>}
      {v.caution && !v.caution.givenAt && <p className="muted" style={{ fontSize: 12 }}>{STATEMENT_CAUTION}</p>}
    </section>
  );
}
