'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { getSession } from '@/lib/client';

export default function Start() {
  const router = useRouter();
  useEffect(() => {
    const s = getSession();
    router.replace(!s ? '/sign-in' : s.surface === 'officer' ? '/officer' : '/home');
  }, [router]);
  return null;
}
