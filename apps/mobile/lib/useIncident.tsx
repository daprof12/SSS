'use client';

import { freshness, type Freshness } from '@erp/domain';
import { useEffect, useState } from 'react';
import { ensureFreshToken } from '@erp/web-ui/api';
import { streamUrl } from './client';

/**
 * Live incident view over SSE (Report Tracking §A6). The server filters the view
 * for this person; `gone` means access ended. Freshness drives "Live / Updated
 * n s ago / Reconnecting".
 */
export function useIncident<T>(id: string) {
  const [view, setView] = useState<T | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastAt, setLastAt] = useState<Date | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    setView(null);
    setGone(null);
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // EventSource reconnects with the URL it was opened with, so on an error we
    // refresh the token ourselves and open a new stream.
    const open = async () => {
      await ensureFreshToken();
      if (closed) return;
      es = new EventSource(streamUrl(`/incidents/${id}/stream`));
      es.addEventListener('incident', (e) => {
        setView(JSON.parse((e as MessageEvent).data));
        setLastAt(new Date());
        setConnected(true);
      });
      es.addEventListener('heartbeat', () => {
        setLastAt(new Date());
        setConnected(true);
      });
      es.addEventListener('gone', (e) => {
        closed = true;
        es?.close();
        setGone(JSON.parse((e as MessageEvent).data).message);
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(() => void open(), 2000);
      };
    };
    void open();
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      closed = true;
      es?.close();
      clearTimeout(retry);
      clearInterval(tick);
    };
  }, [id]);

  const fresh: Freshness | null = lastAt ? freshness(lastAt, now, connected) : null;
  return { view, gone, fresh };
}

export function FreshLabel({ fresh }: { fresh: Freshness | null }) {
  if (!fresh) return null;
  const cls = fresh.kind === 'live' ? '' : fresh.kind === 'stale' ? 'stale' : 'off';
  const text =
    fresh.kind === 'live' ? 'Live' : fresh.kind === 'stale' ? `Updated ${fresh.secondsAgo}s ago` : fresh.smsUpdates ? 'Reconnecting… updates also come by SMS' : 'Reconnecting…';
  return (
    <span className={`fresh ${cls}`} role="status" aria-live="polite">
      <i aria-hidden />
      {text}
    </span>
  );
}
