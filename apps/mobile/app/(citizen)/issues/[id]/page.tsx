'use client';

import { Suspense, use } from 'react';
import { IssueDetail } from '@/components/reports/Issues';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <IssueDetail id={id} back="/issues" sosHref="/report" />
    </Suspense>
  );
}
