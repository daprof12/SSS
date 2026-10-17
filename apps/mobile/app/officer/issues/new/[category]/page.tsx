'use client';

import { use } from 'react';
import { IssueForm } from '@/components/reports/Issues';

export default function Page({ params }: { params: Promise<{ category: string }> }) {
  const { category } = use(params);
  return <IssueForm category={category} base="/officer/issues" sosHref="/officer" />;
}
