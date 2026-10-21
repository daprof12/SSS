'use client';
// Photos, videos and voice notes a citizen attached to a tip or public issue. Fetched with the
// session token (never a public link); each look is written to the audit log by the API.
import { API_URL, api, ensureFreshToken, getSession } from '@erp/web-ui/api';
import { useEffect, useRef, useState } from 'react';

interface Item {
  id: string;
  kind: 'photo' | 'video' | 'voice';
  url: string;
  durationS: number | null;
  at: string;
  blob?: string;
}

export function Evidence({ ownerType, ownerId }: { ownerType: 'tip' | 'issue_case' | 'incident' | 'statement' | 'fine' | 'repair'; ownerId: string; title?: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      const list = await api<Item[]>(`/attachments?ownerType=${ownerType}&ownerId=${ownerId}`).catch(() => [] as Item[]);
      if (!alive) return;
      setItems(list);
      await ensureFreshToken();
      for (const it of list) {
        const r = await fetch(`${API_URL}${it.url}`, { headers: { Authorization: `Bearer ${getSession()?.token ?? ''}` } }).catch(() => null);
        if (!r?.ok || !alive) continue;
        const blob = URL.createObjectURL(await r.blob());
        made.push(blob);
        setItems((xs) => xs?.map((x) => (x.id === it.id ? { ...x, blob } : x)) ?? null);
      }
    })();
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [ownerType, ownerId]);

  // Keyboard: arrows move through the files, Escape closes.
  useEffect(() => {
    if (open == null || !items) return;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
      const n = items.filter((x) => x.kind !== 'voice').length;
      if (e.key === 'ArrowRight') setOpen((i) => (i == null ? i : (i + 1) % n));
      if (e.key === 'ArrowLeft') setOpen((i) => (i == null ? i : (i - 1 + n) % n));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, items]);

  if (!items?.length) return null;
  const visual = items.filter((x) => x.kind !== 'voice');
  const voice = items.filter((x) => x.kind === 'voice');
  const big = open == null ? null : visual[open];
  return (
    <div className="evidence">
      <span className="evidence-label">
        {items.length === 1 ? '1 file' : `${items.length} files`} from the reporter · each view is logged
      </span>
      {voice.map((it, i) => (
        <div key={it.id} className="evidence-voice">
          <span>
            Voice note {voice.length > 1 ? i + 1 : ''}
            {it.durationS ? ` · ${Math.floor(it.durationS / 60)}:${String(it.durationS % 60).padStart(2, '0')}` : ''}
          </span>
          {it.blob ? <audio controls preload="metadata" src={it.blob} aria-label={`Voice note ${i + 1}`} /> : <span className="skeleton" style={{ height: 32, margin: 0, flex: 1 }} />}
        </div>
      ))}
      <ul className="evidence-grid">
        {visual.map((it, i) => (
          <li key={it.id}>
            {!it.blob ? (
              <span className="skeleton" style={{ height: '100%', margin: 0 }} />
            ) : (
              <button type="button" aria-label={`Open ${it.kind} ${i + 1} of ${visual.length}`} onClick={() => setOpen(i)}>
                {it.kind === 'photo' ? <img src={it.blob} alt="" /> : <video src={it.blob} muted playsInline preload="metadata" />}
                {it.kind === 'video' && <span className="evidence-badge">Video</span>}
              </button>
            )}
          </li>
        ))}
      </ul>
      {big?.blob && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label={`${big.kind === 'photo' ? 'Photo' : 'Video'} ${open! + 1} of ${visual.length}`} onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          {big.kind === 'photo' ? <img src={big.blob} alt="" /> : <video src={big.blob} controls autoPlay playsInline />}
          <button ref={closeBtn} type="button" className="viewer-close" aria-label="Close" onClick={() => setOpen(null)}>
            ×
          </button>
          {visual.length > 1 && <span className="viewer-count">{open! + 1} / {visual.length}</span>}
        </div>
      )}
    </div>
  );
}
