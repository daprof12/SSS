'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { StolenFlow } from '@/components/items/StolenFlow';

function Flow() {
  return <StolenFlow itemId={useSearchParams().get('item')} />;
}

export default function Page() {
  return (
    <Suspense>
      <Flow />
    </Suspense>
  );
}
