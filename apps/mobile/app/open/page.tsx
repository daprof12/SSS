'use client';
// Where a tapped alert lands: turns the server's link into this person's page (officer or citizen)
// and goes there. Only known app pages are allowed; anything else goes to the notification list.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { routeFor } from '@/components/NotificationCentre';
import { getSession } from '@/lib/client';

export default function Open() {
  const router = useRouter();
  useEffect(() => {
    const s = getSession();
    if (!s) return router.replace('/sign-in');
    const link = new URLSearchParams(window.location.search).get('link');
    const to = routeFor(link, s.surface);
    router.replace(to ?? (s.surface === 'officer' ? '/officer/notifications' : '/notifications'));
  }, [router]);
  return <main className="app bare" aria-busy="true" />;
}
