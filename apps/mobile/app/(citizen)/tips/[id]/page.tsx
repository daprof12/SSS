'use client';

import { Suspense, use } from 'react';
import { TipDetail } from '@/components/reports/TipDetail';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <TipDetail id={id} back="/tips" />
    </Suspense>
  );
}
