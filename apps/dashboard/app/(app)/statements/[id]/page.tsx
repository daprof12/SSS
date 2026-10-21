'use client';
// Board "Station statement view": the reporter's original and the English record they signed, the
// seal, the access log, and the two ways to question it (more detail, or a certified translator).
import { api, ApiError, downloadFile } from '@erp/web-ui/api';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { dateTime, useToast } from '@/components/Agency';
import { Evidence } from '@/components/Evidence';
import { TakeInPerson, type StatementView } from '@/components/Statements';

interface View extends StatementView {
  stateLabel: string;
  report: { id: string; label: string };
  station: string | null;
  reporter: string;
  requestNote: string | null;
  changeNote: string | null;
  translatorCheck: { state: string; note: string } | null;
  versions: { version: number; language: string; languageName: string; original: string; english: string; confidence: number | null; flagged: string[]; signedWith: string; signedAt: string; seal: string; takenBy: string | null; present: string | null }[];
  latest: { version: number; of: number; seal: string; signedAt: string } | null;
  access: { action: string; by: string; note: string | null; at: string }[];
}
const ACTION: Record<string, string> = {
  opened: 'opened the statement',
  downloaded: 'downloaded the PDF',
  detail_requested: 'asked for more detail',
  translator_check: 'asked for a translator check',
  shared: 'shared a view-only copy',
  shared_opened: 'opened the shared copy',
  code_sent: 'sent the confirmation code',
  taken_in_person: 'took it down in person',
};
const SIGNED_WITH: Record<string, string> = { pin: 'PIN', biometric: 'face check', phone_code: 'code sent to their phone' };

export default function StatementView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState<'translator' | 'detail' | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<View>(`/statements/${id}`)
      .then((x) => {
        setV(x);
        setPick(x.versions.length - 1);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not open the statement.'));
  }, [id]);
  useEffect(load, [load]);

  const send = async (kind: 'translator' | 'detail') => {
    setTried(kind);
    if (why.trim().length < 5) return;
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/statements/${id}/${kind === 'translator' ? 'translator-check' : 'request-change'}`, { method: 'POST', body: JSON.stringify({ note: why.trim() }) });
      setToast(r.message);
      setWhy('');
      setTried(null);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="card empty">
        <strong>{error}</strong>
        <Link href="/incidents">Back to live incidents</Link>
      </div>
    );
  }
  if (!v) return <div className="skeleton" style={{ height: 240 }} />;
  const ver = v.versions[pick];
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>
            {v.form} {v.number}
          </h1>
          <p className="lede">
            {v.report.label}, {ver ? `signed by ${v.maker} ${dateTime(ver.signedAt)}, version ${ver.version} of ${v.versions.length}` : `${v.mode === 'in_person' ? 'being taken from' : 'asked of'} ${v.maker}, not signed yet`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" href={`/incidents/${v.report.id}`}>
            Back to incident
          </Link>
          {ver && (
            <button className="btn" type="button" onClick={() => downloadFile(`/statements/${v.id}/statement.pdf`, `${v.number}-v${ver.version}.pdf`).then(() => load()).catch((e) => setToast(e instanceof ApiError ? e.message : 'Could not download.'))}>
              Download PDF
            </button>
          )}
        </div>
      </div>

      {v.mode === 'in_person' && v.state !== 'signed' && <TakeInPerson v={v} onChange={load} onToast={setToast} />}
      {!ver && v.mode === 'self' && (
        <div className="banner info">
          <strong>Waiting for {v.maker}</strong>
          {v.changeNote ? `You asked: “${v.changeNote}”.` : v.requestNote ?? 'They are told and can answer in their own language.'}
        </div>
      )}
      {v.state === 'change_requested' && ver && (
        <div className="banner info">
          <strong>More detail asked</strong>“{v.changeNote}”. The reporter signs a new version; this one stays on record.
        </div>
      )}
      {v.versions.length > 1 && (
        <div className="segmented tabs" role="tablist" aria-label="Version">
          {v.versions.map((x, i) => (
            <button key={x.version} type="button" role="tab" aria-selected={pick === i} aria-pressed={pick === i} onClick={() => setPick(i)}>
              Version {x.version}
            </button>
          ))}
        </div>
      )}

      {ver && (
        <div className="grid two">
          <section className="card" aria-labelledby="orig">
            <h2 id="orig">
              {v.maker}, original, {ver.languageName}
            </h2>
            {v.caution && (
              <p className="muted" style={{ fontSize: 13 }}>
                Caution read {v.caution.givenAt ? dateTime(v.caution.givenAt) : '—'}: “{v.caution.text}”
              </p>
            )}
            <p style={{ whiteSpace: 'pre-wrap' }}>{ver.original}</p>
            <Evidence ownerType="statement" ownerId={v.id} />
          </section>
          <section className="card" aria-labelledby="eng">
            <h2 id="eng">Official English record</h2>
            <div className="banner info" style={{ whiteSpace: 'pre-wrap' }}>
              {ver.english}
            </div>
            <dl className="facts">
              <div>
                <dt>AI confidence</dt>
                <dd>{ver.confidence == null ? '—' : `${Math.round(ver.confidence * 100)}%, ${ver.flagged.length} ${ver.flagged.length === 1 ? 'word' : 'words'} flagged`}</dd>
              </div>
              <div>
                <dt>{v.maker.split(' ')[0]} confirmed</dt>
                <dd className="success">
                  Yes, {dateTime(ver.signedAt)}, {SIGNED_WITH[ver.signedWith] ?? ver.signedWith}
                </dd>
              </div>
              {ver.takenBy && (
                <div>
                  <dt>Taken in person by</dt>
                  <dd>
                    {ver.takenBy}
                    {ver.present ? `, ${ver.present} present` : ''}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        </div>
      )}

      {ver && (
        <section className="card" aria-labelledby="seal">
          <h2 id="seal">Seal</h2>
          <dl className="facts">
            <div>
              <dt>Seal code</dt>
              <dd style={{ fontFamily: 'ui-monospace, monospace' }}>{ver.seal}</dd>
            </div>
            <div>
              <dt>Locked</dt>
              <dd className="success">Yes, no one can edit</dd>
            </div>
            <div>
              <dt>Versions</dt>
              <dd>{v.versions.length}</dd>
            </div>
          </dl>
          <div className="banner info">
            <strong>You cannot edit this</strong>
            To add or fix something, send a request. The reporter signs a new version, and the old one stays on record.
          </div>
        </section>
      )}

      <div className="grid two">
        <section className="card" aria-labelledby="doubt">
          <h2 id="doubt">If you doubt the translation</h2>
          <div className="banner warning">
            <strong>AI translation is a working record</strong>
            For court or formal cases, ask for a certified human translator to check the original. Their check is added beside the AI text.
          </div>
          {v.translatorCheck?.state === 'requested' && <p className="muted">A translator check is asked for: “{v.translatorCheck.note}”.</p>}
          <label className="field" data-invalid={!!tried && why.trim().length < 5}>
            <span>Reason</span>
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={1000} aria-invalid={!!tried && why.trim().length < 5} />
            {!!tried && why.trim().length < 5 && <span className="field-error">{tried === 'translator' ? 'Say what looks wrong, so the translator knows where to look.' : 'Say what is missing, so the reporter knows what to add.'}</span>}
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" type="button" disabled={busy || !ver || v.translatorCheck?.state === 'requested'} onClick={() => send('translator')}>
              Request translator check
            </button>
            <button className="btn primary" type="button" disabled={busy || v.state !== 'signed'} onClick={() => send('detail')}>
              Request more detail
            </button>
          </div>
        </section>
        <section className="card" aria-labelledby="log">
          <h2 id="log">Access log</h2>
          {!v.access.length && <p className="muted">No one has opened it yet.</p>}
          {v.access.map((a, i) => (
            <div className="row" key={i}>
              <div className="label">
                <strong>
                  {a.by} {ACTION[a.action] ?? a.action}
                </strong>
                {a.note && <span>“{a.note}”</span>}
              </div>
              <span className="muted">{dateTime(a.at)}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
