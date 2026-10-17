'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Note {
  id: string;
  title: string;
  body: string;
  link: string | null;
  at: string;
  unread: boolean;
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** Top-bar bell backed by /me/notifications (unread dot, list, mark all read). */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ unread: number; items: Note[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const load = useCallback(() => {
    api<{ unread: number; items: Note[] }>('/me/notifications')
      .then(setData)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Foundation polls; the push channel replaces this.
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    load();
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, load]);

  const unread = data?.unread ?? 0;
  const markAll = async () => {
    await api('/me/notifications/read-all', { method: 'POST' }).catch(() => {});
    load();
  };
  const openNote = async (n: Note) => {
    if (n.unread) await api(`/me/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    setOpen(false);
    load();
    if (n.link?.startsWith('/incidents/')) router.push(n.link);
  };

  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" type="button" aria-haspopup="dialog" aria-expanded={open} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="dot" />}
      </button>
      {open && (
        <div className="menu-panel notes" role="dialog" aria-label="Notifications">
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong>Notifications</strong>
            {unread > 0 && (
              <button type="button" className="link-btn" onClick={markAll}>
                Mark all read
              </button>
            )}
          </header>
          {!data ? (
            <div className="skeleton" />
          ) : data.items.length === 0 ? (
            <p className="notes-empty">You are all caught up.</p>
          ) : (
            <ul className="notes-list">
              {data.items.slice(0, 20).map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => openNote(n)} className={n.unread ? 'unread' : ''}>
                    <span className="notes-title">
                      {n.unread && <i aria-label="Unread" />}
                      {n.title}
                      <time dateTime={n.at}>{ago(n.at)}</time>
                    </span>
                    <span className="notes-body">{n.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
