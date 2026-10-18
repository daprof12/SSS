'use client';
// Small pieces shared by the officer History, Team and Profile screens.

export const mmss = (s: number | null | undefined) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
export const rating = (r: number | null | undefined) => (r == null ? '–' : r.toFixed(1));
export const shortDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const dateTime = (d: string) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const clockTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const DOTS = ['var(--color-signal)', 'var(--color-success)', 'var(--color-warning)', 'var(--color-emergency)'];
/** Team colour dots on the board: "you" first in cyan, then green, yellow, red. */
export function Dot({ i, off, size = 56 }: { i: number; off?: boolean; size?: number }) {
  return <span className="team-dot" style={{ width: size, height: size, background: off ? 'var(--color-text-disabled)' : DOTS[i % DOTS.length] }} aria-hidden />;
}
