'use client';
// Board "Station roster": who is on duty day by day. Reports go only to officers on duty.
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

type Kind = 'day' | 'night' | 'off' | 'leave';
interface Roster {
  week: string;
  days: { date: string; label: string }[];
  officers: { id: string; name: string; days: Kind[] }[];
  perDay: { day: number; night: number }[];
  gaps: { day: string; shift: string; short: number; leave: boolean }[];
  rules: { dayStart: string; nightStart: string; minOnDuty: number };
  publishedAt: string | null;
}
const NEXT: Record<Kind, Kind> = { day: 'night', night: 'off', off: 'leave', leave: 'day' };
const LABEL: Record<Kind, string> = { day: 'Day', night: 'Night', off: 'Off', leave: 'Leave' };
const DAYNAME: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const shiftWeek = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
};

export default function RosterPage() {
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [r, setR] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<{ dayStart: string; nightStart: string; minOnDuty: string } | null>(null);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Roster>(`/me/station/roster${week ? `?week=${week}` : ''}`)
      .then((x) => {
        setR(x);
        setRules((cur) => cur ?? { dayStart: x.rules.dayStart, nightStart: x.rules.nightStart, minOnDuty: String(x.rules.minOnDuty) });
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the roster.'));
  }, [week]);
  useEffect(load, [load]);

  const cycle = async (officerId: string, i: number) => {
    if (!r) return;
    const cur = r.officers.find((o) => o.id === officerId)!.days[i]!;
    const kind = NEXT[cur];
    setR({ ...r, officers: r.officers.map((o) => (o.id === officerId ? { ...o, days: o.days.map((d, j) => (j === i ? kind : d)) } : o)) });
    try {
      await api('/me/station/roster', { method: 'PUT', body: JSON.stringify({ officerId, date: r.days[i]!.date, kind }) });
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not save.');
      load();
    }
  };
  const post = async (path: string) => {
    if (!r) return;
    try {
      setToast((await api<{ message: string }>(path, { method: 'POST', body: JSON.stringify({ week: r.week }) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not do that.');
    }
  };
  const saveRules = async () => {
    if (!rules) return;
    try {
      setToast((await api<{ message: string }>('/me/station/settings', { method: 'PATCH', body: JSON.stringify({ dayStart: rules.dayStart, nightStart: rules.nightStart, minOnDuty: Number(rules.minOnDuty) }) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };
  const min = r?.rules.minOnDuty ?? 1;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Roster</h1>
          <p className="lede">Who is on duty, day by day. The platform sends reports only to officers on duty.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={() => post('/me/station/roster/copy-last-week')} disabled={!r}>
            Copy last week
          </button>
          <button className="btn primary" type="button" onClick={() => post('/me/station/roster/publish')} disabled={!r}>
            Publish roster
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <section className="card" style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="icon-btn" type="button" aria-label="Previous week" onClick={() => r && setWeek(shiftWeek(r.week, -1))}>
              ‹
            </button>
            <h2 style={{ margin: 0 }}>Week of {r ? new Date(`${r.week}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '…'}</h2>
            <button className="icon-btn" type="button" aria-label="Next week" onClick={() => r && setWeek(shiftWeek(r.week, 1))}>
              ›
            </button>
          </div>
          <span className="muted">
            Click a cell to change it: Day → Night → Off → Leave.{r?.publishedAt ? ` Last published ${new Date(r.publishedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.` : ' Not published yet.'}
          </span>
        </div>
        {!r && <div className="skeleton" style={{ height: 240 }} />}
        {r && (
          <table className="roster">
            <thead>
              <tr>
                <th>Officer</th>
                {r.days.map((d) => (
                  <th key={d.date}>
                    {d.label}
                    <div className="muted" style={{ fontWeight: 400 }}>
                      {new Date(`${d.date}T12:00:00Z`).getUTCDate()}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.officers.map((o) => (
                <tr key={o.id}>
                  <td>
                    <strong>{o.name}</strong>
                  </td>
                  {o.days.map((k, i) => (
                    <td key={i}>
                      <button type="button" data-kind={k} onClick={() => cycle(o.id, i)} aria-label={`${o.name}, ${r.days[i]!.label}: ${LABEL[k]}. Change`}>
                        {LABEL[k]}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="muted">On duty per day</td>
                {r.perDay.map((c, i) => {
                  const n = Math.min(c.day, c.night);
                  return (
                    <td key={i} style={{ textAlign: 'center', fontWeight: 700, color: n >= min ? 'var(--color-success-text)' : n === 0 ? 'var(--color-emergency-text)' : 'var(--color-warning-text)' }}>
                      {c.day} / {c.night}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        )}
      </section>
      <div className="grid two">
        <section className="card" aria-labelledby="gaps">
          <h2 id="gaps" style={{ marginTop: 0 }}>
            Gaps to fill
          </h2>
          {r && !r.gaps.length && <p className="muted">Every shift has at least {min} on duty.</p>}
          {r?.gaps.map((g, i) => (
            <div className="row" key={i}>
              <div className="label">
                <strong>
                  {DAYNAME[g.day]} {g.shift}
                </strong>
                <span>{g.leave ? 'An officer is on leave' : 'Below the minimum on duty'}</span>
              </div>
              <strong style={{ color: g.short >= min ? 'var(--color-emergency-text)' : 'var(--color-warning-text)' }}>{g.short} short</strong>
            </div>
          ))}
        </section>
        <section className="card" aria-labelledby="rules">
          <h2 id="rules" style={{ marginTop: 0 }}>
            Shift rules
          </h2>
          {rules && (
            <>
              <label className="field">
                <span>Day shift starts</span>
                <input type="time" value={rules.dayStart} onChange={(e) => setRules({ ...rules, dayStart: e.target.value })} />
              </label>
              <label className="field">
                <span>Night shift starts</span>
                <input type="time" value={rules.nightStart} onChange={(e) => setRules({ ...rules, nightStart: e.target.value })} />
              </label>
              <label className="field">
                <span>Minimum on duty per shift</span>
                <input inputMode="numeric" value={rules.minOnDuty} onChange={(e) => setRules({ ...rules, minOnDuty: e.target.value.replace(/\D/g, '') })} />
              </label>
              <button className="btn" type="button" onClick={saveRules}>
                Save rules
              </button>
              <p className="muted" style={{ marginBottom: 0 }}>
                If fewer than the minimum are on duty, reports overflow to the next station and the station head is told.
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
