'use client';
// A view-only copy of a signed statement, shared by its author with a lawyer or family (7 days).
import { api, ApiError } from '@erp/web-ui/api';
import { use, useEffect, useState } from 'react';

interface Shared {
  number: string;
  report: string;
  station: string | null;
  version: number;
  language: string;
  original: string;
  english: string;
  signedAt: string;
  seal: string;
}

export default function SharedStatement({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [s, setS] = useState<Shared | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Shared>(`/shared/statements/${encodeURIComponent(token)}`)
      .then(setS)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not open this link.'));
  }, [token]);
  return (
    <main className="app bare">
      <p className="section-label">Signed statement, view only</p>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      {!s && !err && <div className="skeleton" style={{ height: 240 }} />}
      {s && (
        <>
          <h1 style={{ margin: '0 0 4px' }}>{s.number}</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {s.report}
            {s.station ? ` · ${s.station}` : ''} · version {s.version} · signed {new Date(s.signedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
          <div className="banner info">
            <strong>Official English record</strong>
            <span style={{ whiteSpace: 'pre-wrap' }}>{s.english}</span>
          </div>
          {s.language !== 'English' && (
            <div className="card">
              <span className="section-label" style={{ margin: 0 }}>
                Original, {s.language}
              </span>
              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{s.original}</p>
            </div>
          )}
          <div className="facts-list">
            <div>
              <span className="muted">Seal code</span>
              <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{s.seal}</strong>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            This copy cannot be changed. Opening it is recorded for the author.
          </p>
        </>
      )}
    </main>
  );
}
