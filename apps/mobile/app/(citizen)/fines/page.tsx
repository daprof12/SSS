'use client';

import { formatNaira } from '@erp/domain';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

interface Fine {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  dueKobo: number;
  report: { label: string } | null;
  appealBy: string;
  canAppeal: boolean;
}
interface Mine {
  trust: { score: number; band: string };
  fines: Fine[];
  warnings: { label: string; at: string }[];
  policy: { warningsBeforeFine: number; amountKobo: number; appealDays: number; windowDays: number };
}
const TABS = [
  ['open', 'Open', ['open', 'reduced', 'upheld']],
  ['appealed', 'Appealed', ['appealed']],
  ['paid', 'Paid', ['paid']],
  ['waived', 'Waived', ['waived']],
] as const;
const TONE: Record<string, string> = { open: 'warning', reduced: 'warning', upheld: 'critical', appealed: 'info', paid: 'success', waived: 'success' };
const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Fines and appeals (States doc: tabs Open, Appealed, Paid, Waived; empty "No fines. Your trust score is [score]."). */
export default function Fines() {
  const [m, setM] = useState<Mine | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('open');
  useEffect(() => {
    api<Mine>('/me/fines').then(setM).catch(() => {});
  }, []);
  const states: readonly string[] = TABS.find(([k]) => k === tab)![2];
  const list = m?.fines.filter((f) => states.includes(f.state)) ?? [];
  return (
    <main className="app">
      <Header title="Fines and appeals" back="/profile" />
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Trust score</h2>
          <strong style={{ fontSize: 'var(--text-xl)' }}>{m?.trust.score ?? '…'}</strong>
        </div>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          {m
            ? `A false alarm gives a warning first. After ${m.policy.warningsBeforeFine} ${m.policy.warningsBeforeFine === 1 ? 'warning' : 'warnings'} in ${Math.round(m.policy.windowDays / 30)} months, the next one is a fine of ${formatNaira(m.policy.amountKobo)}. You can appeal within ${m.policy.appealDays} days. Fines never slow down a later report.`
            : ''}
        </p>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l, s]) => {
          const n = m?.fines.filter((f) => (s as readonly string[]).includes(f.state)).length ?? 0;
          return (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {l}
              {n ? ` ${n}` : ''}
            </button>
          );
        })}
      </div>
      {!m && <div className="skeleton" />}
      {m && !list.length && (
        <div className="empty">
          <strong>{tab === 'open' ? 'No fines.' : `Nothing ${TABS.find(([k]) => k === tab)![1].toLowerCase()}.`}</strong>
          Your trust score is {m.trust.score}.
        </div>
      )}
      {!!list.length && (
        <div className="list">
          {list.map((f) => (
            <Link key={f.id} className="row" href={`/fines/${f.id}`}>
              <span className="icon">
                <Icon name="flag" />
              </span>
              <span className="grow">
                <strong>
                  Fine {f.number}, {formatNaira(f.dueKobo)}
                </strong>
                <span className="sub">
                  {f.report?.label}
                  {f.canAppeal ? ` · appeal by ${day(f.appealBy)}` : ''}
                </span>
              </span>
              <span className={`chip ${TONE[f.state] ?? 'neutral'}`}>{f.stateLabel}</span>
            </Link>
          ))}
        </div>
      )}
      {!!m?.warnings.length && (
        <>
          <p className="section-label">Warnings</p>
          <div className="list">
            {m.warnings.map((w) => (
              <div key={w.at} className="row" style={{ cursor: 'default' }}>
                <span className="grow">
                  <strong>{w.label}</strong>
                  <span className="sub">Warning, no fine · {day(w.at)}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
