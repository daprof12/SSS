'use client';
// Board "Officer activity detail": facts, the team with each officer's rating and reward, and the citizen's comment.
import { use, useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { dateTime, Dot, mmss, rating } from '@/components/officer/work';
import { api, ApiError } from '@/lib/client';
import { formatNaira } from '@erp/domain';

interface Detail {
  title: string;
  stars: number | null;
  date: string;
  arrivalS: number | null;
  reportsMerged: number;
  outcome: string;
  resolved: boolean;
  team: { name: string; you: boolean; role: string; rating: number | null; rewardKobo: number | null }[];
  comment: string | null;
  rewardNote: string | null;
}

export default function ActivityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/me/officer/history/${id}`)
      .then(setD)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load this response.'));
  }, [id]);
  if (err)
    return (
      <main className="app">
        <Header title="History" back="/officer/history" />
        <div className="card empty">
          <strong>{err}</strong>
        </div>
      </main>
    );
  if (!d)
    return (
      <main className="app">
        <div className="skeleton" style={{ height: 200 }} />
      </main>
    );
  return (
    <main className="app">
      <Header title={d.title} back="/officer/history">
        <span className="rated big">{d.stars ? d.stars.toFixed(1) : 'Not rated'}</span>
      </Header>
      <dl className="facts-list">
        <div>
          <dt>Date</dt>
          <dd>{dateTime(d.date)}</dd>
        </div>
        <div>
          <dt>Arrival</dt>
          <dd>{mmss(d.arrivalS)}</dd>
        </div>
        <div>
          <dt>Reports merged</dt>
          <dd>{d.reportsMerged}</dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>{d.outcome}</dd>
        </div>
      </dl>
      <h2 className="section-title">Team and ratings</h2>
      <div className="member-list">
        {d.team.map((m, i) => (
          <div key={i} className="member-row">
            <Dot i={m.you ? 0 : i + (d.team[0]?.you ? 0 : 1)} size={48} />
            <span className="grow">
              <strong>{m.name}</strong>
              <span className="sub">{m.role}</span>
            </span>
            <span className="rated">{rating(m.rating)}</span>
            {m.rewardKobo != null && <span className="reward">+{formatNaira(m.rewardKobo).replace('.00', '')}</span>}
          </div>
        ))}
      </div>
      {d.comment && (
        <div className="card" style={{ marginTop: 12 }}>
          <span className="muted">Citizen comment</span>
          <p style={{ margin: '4px 0 0' }}>“{d.comment}”</p>
        </div>
      )}
      <p className="muted center" style={{ marginTop: 24 }}>
        {d.rewardNote ?? 'Rewards from ratings show here once your station pays them.'}
      </p>
    </main>
  );
}
