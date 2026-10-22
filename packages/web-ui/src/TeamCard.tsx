'use client';
// The team on a report: more than one officer (or staff) can handle a report together, a lead with a
// second unit or another agency's unit. Stacked avatars and the team's rating on top, then each
// member with their role and rating.
import { Avatar, AvatarStack, type PresenceStatus } from './Avatar';
import { Rating } from './Rating';

export interface TeamCardMember {
  name: string;
  role: string;
  badgeNo?: string | null;
  stationName?: string;
  rating: number | null;
  you?: boolean;
}

export function TeamCard({ members, title, status }: { members: TeamCardMember[]; title?: string; status?: PresenceStatus | null }) {
  const stations = [...new Set(members.map((m) => m.stationName).filter(Boolean))];
  const rated = members.filter((m) => m.rating != null);
  const teamRating = rated.length ? Math.round((rated.reduce((a, m) => a + m.rating!, 0) / rated.length) * 10) / 10 : null;
  return (
    <section className="ui-team-card" aria-label={title ?? `Team of ${members.length}`} style={{ display: 'grid', gap: 10, padding: 14, borderRadius: 16, background: 'var(--color-surface, #111827)', border: '1px solid var(--color-divider, #333)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <AvatarStack names={members.map((m) => m.name)} status={status} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: 'block' }}>{title ?? `A team of ${members.length} officers`}</strong>
          <span style={{ color: 'var(--color-text-secondary, #9ca3af)', fontSize: 'var(--text-sm, 0.875rem)' }}>
            {stations.length === 1 ? stations[0] : `${stations.length} stations`}
          </span>
        </span>
        <Rating value={teamRating} empty="Not rated yet" />
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {members.map((m, i) => (
          <li key={`${m.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--color-divider, #333)' }}>
            <Avatar name={m.name} size={32} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ display: 'block' }}>{m.you ? `You (${m.name})` : m.name}</strong>
              <span style={{ color: 'var(--color-text-secondary, #9ca3af)', fontSize: 'var(--text-sm, 0.875rem)' }}>
                {[m.role, m.badgeNo && `badge ${m.badgeNo}`, stations.length > 1 ? m.stationName : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <Rating value={m.rating} empty="New" />
          </li>
        ))}
      </ul>
    </section>
  );
}
