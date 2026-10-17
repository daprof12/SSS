'use client';

import { useEffect, useState } from 'react';
import { flushOutbox } from '@/lib/outbox';

/** Registers the service worker (production only) and shows the offline banner. */
export function Pwa() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const update = () => {
      setOffline(!navigator.onLine);
      // Back online: send anything saved while offline (same client ref → no duplicates).
      if (navigator.onLine) void flushOutbox();
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="offline-banner" role="status">
      You are offline. Reports are saved and sent when you reconnect.
    </div>
  );
}
