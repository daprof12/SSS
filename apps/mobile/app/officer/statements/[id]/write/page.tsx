'use client';
// An officer's own statement on a report they attended: written and signed with their PIN, like a citizen's.
import { use } from 'react';
import { StatementWriter } from '@/components/StatementWriter';

export default function OfficerWriteStatement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <StatementWriter id={id} home="/officer/statements" reportHref={(r) => `/officer/incidents/${r}`} />;
}
