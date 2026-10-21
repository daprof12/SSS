'use client';
// Boards "Statement record in any language", "Statement review and sign", "Statement signed, download".
import { use } from 'react';
import { StatementWriter } from '@/components/StatementWriter';

export default function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <StatementWriter id={id} />;
}
