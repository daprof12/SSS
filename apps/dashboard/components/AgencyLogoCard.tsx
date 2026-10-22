'use client';
// Agency settings, "Logo": upload or replace it (PNG, JPEG or WebP, up to 512 KB). It shows on the
// agency's dashboard, its stations' dashboards and its officers' app.
import { AgencyLogo, BRAND_CHANGED_EVENT } from '@erp/web-ui/AgencyLogo';
import { api, ApiError } from '@erp/web-ui/api';
import { useRef, useState } from 'react';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 512 * 1024;

export function AgencyLogoCard({ agencyId, name, initial, canEdit, onDone }: { agencyId: string; name: string; initial: string | null; canEdit: boolean; onDone: (m: string) => void }) {
  const [url, setUrl] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const changed = () => window.dispatchEvent(new Event(BRAND_CHANGED_EVENT));

  const upload = async (f: File) => {
    setErr(null);
    if (!TYPES.includes(f.type)) return setErr('Use a PNG, JPEG or WebP image.');
    if (f.size > MAX) return setErr('Use an image under 512 KB.');
    setBusy(true);
    try {
      const r = await api<{ message: string; logoUrl: string }>(`/agencies/${agencyId}/logo`, { method: 'PUT', body: f, headers: { 'Content-Type': f.type } });
      setUrl(r.logoUrl);
      changed();
      onDone(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not upload. Try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <section className="card" aria-labelledby="logo">
      <h2 id="logo" style={{ marginTop: 0 }}>
        Logo
      </h2>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <AgencyLogo url={url} name={name} size={72} radius={14} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Shown on your dashboard, your stations&apos; dashboards and your officers&apos; app. A square PNG, JPEG or WebP, up to 512 KB.
          </p>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input ref={input} type="file" accept={TYPES.join(',')} hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
              <button className="btn primary" type="button" disabled={busy} onClick={() => input.current?.click()}>
                {busy ? 'Uploading…' : url ? 'Replace logo' : 'Upload logo'}
              </button>
              {url && (
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      onDone((await api<{ message: string }>(`/agencies/${agencyId}/logo`, { method: 'DELETE' })).message);
                      setUrl(null);
                      changed();
                    } catch (e) {
                      setErr(e instanceof ApiError ? e.message : 'Could not remove. Try again.');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          )}
          {err && (
            <span className="field-error" role="alert" style={{ display: 'block', marginTop: 8 }}>
              {err}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
