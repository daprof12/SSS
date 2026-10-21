'use client';
// Board "Officer team": the station's officers with duty and rating; shifts; recent activity.
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { clockTime, mmss } from '@/components/officer/work';
import { api, ApiError } from '@/lib/client';

interface Team {
  name: string;
  agency: string;
  stats: { rating: number | null; responses: number; avgArrivalS: number | null };
  members: { id: string; name: string; you: boolean; rank: string | null; onDuty: boolean; backAt: string | null; rating: number | null }[];
  shifts: { name: string; you: boolean; startsAt: string; endsAt: string; kind: string; vehicle: string | null }[];
  activity: { at: string; text: string }[];
}
type Tab = 'members' | 'shifts' | 'activity';
const KIND: Record<string, string> = { day: 'Day shift', night: 'Night shift', off: 'Off', leave: 'On leave' };
const dayLabel = (d: string) => {
  const x = new Date(d);
  const today = new Date();
  const diff = Math.round((new Date(x.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
};

export default function OfficerTeam() {
  const [t, setT] = useState<Team | null>(null);
  const [tab, setTab] = useState<Tab>('members');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Team>('/me/officer/team')
      .then(setT)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load your team.'));
  }, []);
  const byDay = new Map<string, Team['shifts']>();
  for (const s of t?.shifts ?? []) byDay.set(dayLabel(s.startsAt), [...(byDay.get(dayLabel(s.startsAt)) ?? []), s]);

  return (
    <main className="app">
      <Header title={t?.name ?? 'Team'} back="/officer/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        {t?.agency ?? ''}
      </p>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <small>Team rating</small>
          <strong>
            <Rating value={t?.stats.rating} size={16} />
          </strong>
        </div>
        <div className="stat">
          <small>Responses</small>
          <strong>{t?.stats.responses ?? '–'}</strong>
        </div>
        <div className="stat">
          <small>Avg arrival</small>
          <strong style={{ color: 'var(--color-signal-text)' }}>{mmss(t?.stats.avgArrivalS)}</strong>
        </div>
      </div>
      <div className="chips learn-chips" role="tablist" aria-label="Team">
        {(
          [
            ['members', 'Members'],
            ['shifts', 'Shifts'],
            ['activity', 'Activity'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {!t ? (
        [0, 1, 2].map((i) => <div key={i} className="skeleton" />)
      ) : tab === 'members' ? (
        <div className="member-list" role="tabpanel">
          {t.members.map((m, i) => (
            <div key={m.id} className="member-row">
              <Avatar name={m.name} status={m.onDuty ? 'on_duty' : 'off_duty'} />
              <span className="grow">
                <strong>{m.name}</strong>
                <span className="sub">
                  {m.rank ? `${m.rank}, ` : ''}
                  {m.onDuty ? 'on duty' : m.backAt ? `off duty, back ${dayLabel(m.backAt).toLowerCase()} ${clockTime(m.backAt)}` : 'off duty'}
                </span>
              </span>
              <Rating value={m.rating} />
            </div>
          ))}
        </div>
      ) : tab === 'shifts' ? (
        <div role="tabpanel">
          {!t.shifts.length ? (
            <div className="card empty">
              <strong>No shifts this week.</strong>Your station head sets the roster.
            </div>
          ) : (
            [...byDay].map(([day, list]) => (
              <div key={day}>
                <p className="section-label">{day}</p>
                <div className="list">
                  {list.map((s, i) => (
                    <div key={i} className="row" style={{ cursor: 'default' }}>
                      <span className="grow">
                        <strong>{s.name}</strong>
                        <span className="sub">
                          {KIND[s.kind] ?? s.kind}
                          {s.kind === 'day' || s.kind === 'night' ? `, ${clockTime(s.startsAt)} to ${clockTime(s.endsAt)}` : ''}
                          {s.vehicle ? ` · ${s.vehicle}` : ''}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div role="tabpanel">
          {!t.activity.length ? (
            <div className="card empty">
              <strong>Quiet week.</strong>What your team does on reports shows here.
            </div>
          ) : (
            <ol className="timeline-list">
              {t.activity.map((a, i) => (
                <li key={i}>
                  <time>{clockTime(a.at)}</time>
                  <span>{a.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </main>
  );
}
