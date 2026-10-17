'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL, api, ApiError, ensureFreshToken, getSession } from '@erp/web-ui/api';
import { ErrorBox, focusFirstError, useSubmit } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { dateTime, plural, shortDate } from './Agency';

interface Share {
  id: string;
  note: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  views: number;
  lastViewedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}
interface Created {
  id: string;
  path: string;
  token: string;
  expiresAt: string;
}

const DAYS = [1, 3, 7, 14];
const STATUS: Record<Share['status'], [string, string]> = {
  active: ['success', 'Active'],
  expired: ['neutral', 'Expired'],
  revoked: ['neutral', 'Turned off'],
};

/** Board "Share the case": the PDF brief and a view-only link for a superior, which expires. */
export function IssueShare({ base, publicNo, onToast }: { base: string; publicNo: string; onToast: (msg: string) => void }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<'share' | { revoke: Share } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [n, setN] = useState(0);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    api<Share[]>(`${base}/shares`)
      .then(setShares)
      .catch((e: ApiError) => setError(e.message));
  }, [base, n]);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      await ensureFreshToken();
      const res = await fetch(`${API_URL}${base}/brief.pdf`, { headers: { Authorization: `Bearer ${getSession()?.token ?? ''}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Could not make the brief. Try again.');
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${publicNo}-brief.pdf`; // the header is not readable across origins
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onToast('Brief downloaded.');
    } catch (e) {
      setError(e instanceof TypeError ? 'You are offline.' : e instanceof Error ? e.message : 'Could not make the brief. Try again.');
    } finally {
      setDownloading(false);
    }
  };

  const active = shares?.filter((s) => s.status === 'active') ?? [];
  const past = shares?.filter((s) => s.status !== 'active') ?? [];

  return (
    <section className="card" aria-labelledby="share">
      <h2 id="share">Share the case</h2>
      <div className="banner info" style={{ margin: 0 }}>
        <strong>Show your superior how much it matters</strong>
        The brief shows the report count, what people say, the history and days open.
      </div>
      {error && (
        <div className="banner critical" role="alert" style={{ margin: '12px 0 0' }}>
          {error}
        </div>
      )}
      <div className="actions">
        <button className="btn" type="button" onClick={download} disabled={downloading}>
          {downloading ? 'Making brief…' : 'Download brief'}
        </button>
        <button className="btn signal" type="button" onClick={() => setOpen('share')}>
          Send to a superior
        </button>
      </div>
      {shares && shares.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>Links</h3>
          {[...active, ...past].map((s) => (
            <div key={s.id} className="row">
              <div className="label">
                <strong>{s.note}</strong>
                <span>
                  {s.status === 'active' ? `Expires ${shortDate(s.expiresAt)}` : `Made ${shortDate(s.createdAt)}`} · {plural(s.views, 'view')}
                  {s.lastViewedAt ? `, last ${dateTime(s.lastViewedAt)}` : ''}
                </span>
              </div>
              <span className={`chip ${STATUS[s.status][0]}`}>{STATUS[s.status][1]}</span>
              {s.status === 'active' && (
                <button className="btn" type="button" onClick={() => setOpen({ revoke: s })}>
                  Turn off
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {open === 'share' && (
        <ShareSheet
          base={base}
          onClose={close}
          onCreated={() => {
            setN((x) => x + 1);
          }}
          onToast={onToast}
        />
      )}
      {open && typeof open === 'object' && (
        <RevokeSheet
          base={base}
          share={open.revoke}
          onClose={close}
          onDone={() => {
            setOpen(null);
            setN((x) => x + 1);
            onToast('Link turned off.');
          }}
        />
      )}
    </section>
  );
}

function ShareSheet({ base, onClose, onCreated, onToast }: { base: string; onClose: () => void; onCreated: () => void; onToast: (msg: string) => void }) {
  const [note, setNote] = useState('');
  const [days, setDays] = useState(7);
  const [tried, setTried] = useState(false);
  const [made, setMade] = useState<Created | null>(null);
  const s = useSubmit();
  const invalid = note.trim().length < 3;
  const link = made ? `${window.location.origin}${made.path}` : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      onToast('Link copied.');
    } catch {
      onToast('Could not copy. Select the link and copy it.');
    }
  };

  if (made)
    return (
      <Sheet
        open
        title="Link ready"
        description={`Anyone with this link can view the brief until ${shortDate(made.expiresAt)}. Every view is counted. You can turn it off at any time.`}
        onClose={onClose}
        footer={
          <>
            <button className="btn" type="button" onClick={onClose}>
              Done
            </button>
            <button className="btn signal" type="button" onClick={copy}>
              Copy link
            </button>
          </>
        }
      >
        <label className="field">
          <span>Link</span>
          <input type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <small>This link is shown once. Send it in your own email or chat.</small>
        </label>
      </Sheet>
    );

  return (
    <Sheet
      open
      title="Send to a superior"
      description="Makes a view-only link to the brief that expires. Your superior does not need an account."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (invalid) return focusFirstError();
              void s.run(async () => {
                setMade(await api<Created>(`${base}/shares`, { method: 'POST', body: JSON.stringify({ note: note.trim(), days }) }));
                onCreated();
              });
            }}
          >
            {s.busy ? 'Making link…' : 'Make link'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && invalid}>
        <span>Note</span>
        <textarea placeholder="For example, 48 people reported this. It needs funding this quarter." value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={tried && invalid} />
        {tried && invalid && <span className="field-error">Add a line on why this needs attention.</span>}
      </label>
      <label className="field">
        <span>Link works for</span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {plural(d, 'day')}
            </option>
          ))}
        </select>
      </label>
    </Sheet>
  );
}

function RevokeSheet({ base, share, onClose, onDone }: { base: string; share: Share; onClose: () => void; onDone: () => void }) {
  const s = useSubmit();
  return (
    <Sheet
      open
      title="Turn off this link?"
      description="Anyone who opens it after this sees that it no longer works. You can make a new link later."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Keep link
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={s.busy}
            onClick={() =>
              s.run(async () => {
                await api(`${base}/shares/${share.id}`, { method: 'DELETE' });
                onDone();
              })
            }
          >
            {s.busy ? 'Turning off…' : 'Turn off link'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <p className="sheet-desc" style={{ margin: 0 }}>
        &ldquo;{share.note}&rdquo; · {plural(share.views, 'view')}
      </p>
    </Sheet>
  );
}
