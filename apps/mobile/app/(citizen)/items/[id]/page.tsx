'use client';

import { Suspense, use } from 'react';
import { ItemDetail } from '@/components/items/MyItems';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <ItemDetail id={id} />
    </Suspense>
  );
}
