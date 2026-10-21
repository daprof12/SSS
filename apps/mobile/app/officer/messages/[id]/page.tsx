'use client';
// A message from the station (board "Station messages"): opening it marks it read; some ask the
// officer to confirm, which the station sees.
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { api, ApiError } from '@/lib/client';

interface Msg {
  id: string;
  title: string;
  body: string;
  urgent: boolean;
  needsConfirm: boolean;
  from: string;
  at: string;
  confirmedAt: string | null;
}

export default function StationMessage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [m, setM] = useState<Msg | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  useEffect(() => {
    api<Msg>(`/me/messages/${id}`).then(setM).catch(() => setM(null));
  }, [id]);
  if (m === null) {
    return (
      <main className="app">
        <Header title="Message" back="/officer/notifications" />
        <div className="empty">
          <strong>Message not found.</strong>
          <Link href="/officer">Back to Home</Link>
        </div>
      </main>
    );
  }
  if (!m) return <main className="app">{<div className="skeleton" style={{ height: 200 }} />}</main>;
  return (
    <main className="app">
      <Header title="From the station" back="/officer/notifications" />
      {m.urgent && (
        <div className="banner critical" role="alert">
          <strong>Urgent</strong>
          Read and act now.
        </div>
      )}
      <div className="card">
        <h2 style={{ margin: '0 0 6px' }}>{m.title}</h2>
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.body}</p>
        <p className="muted" style={{ margin: '12px 0 0', fontSize: 'var(--text-sm)' }}>
          {m.from}, {new Date(m.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
      {m.needsConfirm &&
        (m.confirmedAt ? (
          <div className="banner success">
            <strong>Confirmed</strong>
            The station sees that you read it.
          </div>
        ) : (
          <button
            className="btn block signal"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setM(await api<Msg>(`/me/messages/${id}/confirm`, { method: 'POST' }));
                setToast('Confirmed. The station sees it.');
              } catch (e) {
                setToast(e instanceof ApiError ? e.message : 'Could not confirm.');
              } finally {
                setBusy(false);
              }
            }}
            style={{ minHeight: 56 }}
          >
            I have read it
          </button>
        ))}
      <Toast msg={toast} />
    </main>
  );
}
