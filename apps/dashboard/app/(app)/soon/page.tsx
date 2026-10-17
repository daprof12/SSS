'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function Soon() {
  const page = useSearchParams().get('page') ?? 'This page';
  return (
    <>
      <h1>{page}</h1>
      <div className="card empty">
        <strong>Not built yet</strong>
        This page is specified in the design docs and comes after the foundation.
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Soon />
    </Suspense>
  );
}
