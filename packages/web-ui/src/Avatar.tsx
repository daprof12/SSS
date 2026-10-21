'use client';
// A person's avatar: initials on a colour picked from their name, with an optional status dot at the
// bottom right (on duty, on a report, off duty, invited). The dot replaces a separate status row.
import type { CSSProperties, ReactNode } from 'react';

export type PresenceStatus = 'on_duty' | 'busy' | 'off_duty' | 'invited' | 'online' | 'offline';
const STATUS: Record<PresenceStatus, [string, string]> = {
  on_duty: ['var(--color-success, #22c55e)', 'On duty'],
  online: ['var(--color-success, #22c55e)', 'Online'],
  busy: ['var(--color-warning, #f59e0b)', 'On a report'],
  off_duty: ['var(--color-text-disabled, #6b7280)', 'Off duty'],
  offline: ['var(--color-text-disabled, #6b7280)', 'Offline'],
  invited: ['var(--color-signal, #22d3ee)', 'Invited'],
};
const HUES = ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#4d7c0f'];

/** "Insp. Musa Bello" → "MB": skips ranks and titles. */
export function initials(name: string) {
  const words = name.split(/\s+/).filter((w) => w && !w.endsWith('.') && !/^(CSP|DSP|ASP|SP|Cpl|Sgt|Insp|ACF|FO|Dr|Mr|Mrs|Ms)$/i.test(w));
  return (words.length ? words : name.split(/\s+/)).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

const hue = (name: string) => HUES[[...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]!;

export function statusLabel(s: PresenceStatus) {
  return STATUS[s][1];
}

export function Avatar({
  name,
  size = 44,
  status,
  tone,
  children,
  style,
}: {
  name: string;
  size?: number;
  status?: PresenceStatus | null;
  /** Override the background (for example the person's own avatar in a brand colour). */
  tone?: { bg: string; fg: string };
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const dot = Math.max(10, Math.round(size * 0.28));
  const st = status ? STATUS[status] : null;
  return (
    <span
      className="ui-avatar"
      role={st ? 'img' : undefined}
      aria-label={st ? `${name}, ${st[1].toLowerCase()}` : undefined}
      aria-hidden={st ? undefined : true}
      title={st ? `${name}, ${st[1].toLowerCase()}` : name}
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        flex: 'none',
        display: 'inline-grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: Math.round(size * 0.36),
        background: tone?.bg ?? `color-mix(in srgb, ${hue(name)} 22%, var(--color-surface-raised, #1f2937))`,
        color: tone?.fg ?? `color-mix(in srgb, ${hue(name)} 70%, var(--color-text-primary, #fff))`,
        ...style,
      }}
    >
      {children ?? initials(name)}
      {st && (
        <i
          aria-hidden
          style={{
            position: 'absolute',
            right: Math.round(size * 0.01),
            bottom: Math.round(size * 0.01),
            width: dot,
            height: dot,
            borderRadius: '50%',
            background: st[0],
            border: `${Math.max(2, Math.round(dot * 0.2))}px solid var(--color-bg, #000)`,
            boxSizing: 'border-box',
          }}
        />
      )}
    </span>
  );
}
