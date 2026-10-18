'use client';
// Duty and shifts: today's status and the next two weeks of the roster.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { clockTime } from '@/components/officer/work';
import { api } from '@/lib/client';

interface Shifts {
  onDuty: boolean;
  shifts: { startsAt: string; endsAt: string; kind: string; vehicle: string | null }[];
}
const KIND: Record<string, [string, string]> = { day: ['Day shift', 'info'], night: ['Night shift', 'info'], off: ['Off', 'neutral'], leave: ['On leave', 'warning'] };

export default function MyShifts() {
  const [s, setS] = useState<Shifts | null>(null);
  useEffect(() => {
    api<Shifts>('/me/officer/shifts').then(setS).catch(() => setS({ onDuty: false, shifts: [] }));
  }, []);
  return (
    <main className="app">
      <Header title="Duty and shifts" back="/officer/profile" />
      <div className={`banner ${s?.onDuty ? 'success' : 'info'}`}>
        <strong>{s ? (s.onDuty ? 'You are on duty' : 'You are off duty') : 'Checking…'}</strong>
        {s?.onDuty ? 'You receive dispatch offers near you.' : 'Go on duty from Home to receive offers.'} <Link href="/officer">Open Home</Link>
      </div>
      <p className="section-label">Next two weeks</p>
      {!s ? (
        <div className="skeleton" />
      ) : !s.shifts.length ? (
        <div className="card empty">
          <strong>No shifts on the roster.</strong>Your station head sets the roster. Ask them if this looks wrong.
        </div>
      ) : (
        <div className="list">
          {s.shifts.map((x, i) => (
            <div key={i} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{new Date(x.startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</strong>
                <span className="sub">
                  {x.kind === 'day' || x.kind === 'night' ? `${clockTime(x.startsAt)} to ${clockTime(x.endsAt)}` : 'No duty'}
                  {x.vehicle ? ` · ${x.vehicle}` : ''}
                </span>
              </span>
              <span className={`chip ${KIND[x.kind]?.[1] ?? 'neutral'}`}>{KIND[x.kind]?.[0] ?? x.kind}</span>
            </div>
          ))}
        </div>
      )}
      <p className="muted">Swaps and leave go through your station head.</p>
    </main>
  );
}
