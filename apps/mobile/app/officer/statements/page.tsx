'use client';
// Officer "My statements": officer's statements asked of me (on reports I attended), to write and sign.
// Statements I take from others are on each report.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

interface Mine {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  incidentId: string;
  report: string;
  form: string;
  at: string;
}

export default function OfficerStatements() {
  const [list, setList] = useState<Mine[] | null>(null);
  useEffect(() => {
    api<Mine[]>('/me/statements')
      .then(setList)
      .catch(() => setList([]));
  }, []);
  return (
    <main className="app bare">
      <Header title="My statements" back="/officer/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        Your own statements on reports you attended. Write them in your words and sign with your PIN. Statements you take from others are on each report.
      </p>
      {!list && <div className="skeleton" style={{ height: 160 }} />}
      {list?.length === 0 && (
        <div className="empty">
          <strong>No statements asked of you.</strong>
          Open a report you attended and choose Add statement, then Me.
        </div>
      )}
      {list?.map((s) => (
        <Link key={s.id} className="row card" href={s.state === 'signed' ? `/officer/statements/${s.id}` : `/officer/statements/${s.id}/write`}>
          <span className="grow">
            <strong>
              {s.form}, {s.number}
            </strong>
            <span className="sub">
              {s.report}, {s.state === 'signed' ? 'signed' : s.stateLabel.toLowerCase()}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
      ))}
    </main>
  );
}
