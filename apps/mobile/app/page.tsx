'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Landing } from '@/components/Landing';
import { getSession } from '@/lib/client';

/** Signed in: straight to your app. Signed out: the landing page, which leads to sign-in. */
export default function Start() {
  const router = useRouter();
  const [guest, setGuest] = useState(false);
  useEffect(() => {
    const s = getSession();
    if (!s) return setGuest(true);
    router.replace(s.surface === 'officer' ? '/officer' : '/home');
  }, [router]);
  return guest ? <Landing /> : null;
}
