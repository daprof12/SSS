'use client';

import { Suspense, use } from 'react';
import { StolenDetail } from '@/components/items/StolenDetail';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <StolenDetail id={id} />
    </Suspense>
  );
}
