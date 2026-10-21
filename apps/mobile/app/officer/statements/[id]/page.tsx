'use client';
// Officer's read-only statement view (B7): what the reporter said, the English record they signed,
// the seal. Officers cannot edit it; they can ask for more detail (a new signed version).
import { downloadFile } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Attachments } from '@/components/reports/Attach';
import { api, ApiError } from '@/lib/client';
import { TakeInPerson, type InPersonView } from '@/components/OfficerStatements';

interface View extends InPersonView {
  form: string;
  mode: 'self' | 'in_person';
  number: string;
  state: string;
  stateLabel: string;
  report: { id: string; label: string };
  reporter: string;
  requestNote: string | null;
  changeNote: string | null;
  versions: { version: number; languageName: string; language: string; original: string; english: string; confidence: number | null; signedAt: string; seal: string }[];
}

export default function OfficerStatement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<View | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = () => api<View>(`/statements/${id}`).then(setV).catch(() => setV(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (v === null) {
    return (
      <main className="app bare">
        <Header title="Statement" back="/officer" />
        <div className="empty">
          <strong>Statement not found.</strong>
          <Link href="/officer">Back to Home</Link>
        </div>
      </main>
    );
  }
  if (!v) return <main className="app bare">{<div className="skeleton" style={{ height: 260 }} />}</main>;
  const last = v.versions[v.versions.length - 1];
  return (
    <main className="app bare">
      <Header title={`${v.form} ${v.number}`} back={`/officer/incidents/${v.report.id}`}>
        <span className={`chip ${v.state === 'signed' ? 'success' : 'warning'}`}>{v.state === 'signed' ? 'Signed' : v.state === 'change_requested' ? 'More asked' : 'Waiting'}</span>
      </Header>
      <p className="muted" style={{ marginTop: -8 }}>
        {v.report.label}, from {v.maker}
        {last ? `, version ${last.version} of ${v.versions.length}` : ''}
      </p>
      {v.mode === 'in_person' && v.state !== 'signed' && <TakeInPerson v={v} onChange={() => void load()} onToast={setToast} />}
      {!last && v.mode === 'self' && (
        <div className="banner info">
          <strong>Not signed yet</strong>
          {v.state === 'change_requested' ? `You asked: "${v.changeNote}". ` : ''}You will be told when they sign.
        </div>
      )}
      {last && (
        <>
          <div className="banner info">
            <strong>Official English record</strong>
            <span style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{last.english}</span>
          </div>
          {last.language !== 'en' && (
            <div className="card">
              <span className="section-label" style={{ margin: 0 }}>
                {v.maker}, original, {last.languageName}
              </span>
              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{last.original}</p>
            </div>
          )}
          <div className="facts-list">
            <div>
              <span className="muted">Seal code</span>
              <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{last.seal}</strong>
            </div>
            <div>
              <span className="muted">Signed</span>
              <strong>{new Date(last.signedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</strong>
            </div>
            {last.confidence != null && (
              <div>
                <span className="muted">AI confidence</span>
                <strong>{Math.round(last.confidence * 100)}%</strong>
              </div>
            )}
          </div>
          <Attachments ownerType="statement" ownerId={v.id} title="Recordings" />
          <div className="banner info">You cannot edit this. To add or fix something, ask the reporter; they sign a new version and the old one stays on record.</div>
          <div className="btn-row">
            <button className="btn" type="button" onClick={() => downloadFile(`/statements/${v.id}/statement.pdf`, `${v.number}-v${last.version}.pdf`).then(() => setToast('Downloaded.')).catch((e) => setToast(e instanceof ApiError ? e.message : 'Could not download.'))}>
              Download PDF
            </button>
            <button className="btn signal" type="button" onClick={() => setAsking(true)} disabled={v.state !== 'signed'}>
              Ask for more detail
            </button>
          </div>
        </>
      )}
      <Sheet
        open={asking}
        title="Ask for more detail"
        description="The reporter is told what to add and signs a new version."
        onClose={() => setAsking(false)}
        busy={busy}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const r = await api<{ message: string }>(`/statements/${v.id}/request-change`, { method: 'POST', body: JSON.stringify({ note }) });
                  setAsking(false);
                  setNote('');
                  setToast(r.message);
                  void load();
                } catch (e) {
                  setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send to the reporter
            </button>
          </>
        }
      >
        <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
          <span>What is missing?</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={!!err} placeholder="For example, what were they wearing?" />
        </label>
        {err && <span className="field-error">{err}</span>}
      </Sheet>
      <Toast msg={toast} />
    </main>
  );
}
