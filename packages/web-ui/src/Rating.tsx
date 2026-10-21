'use client';
// A rating with its star, so it reads as a rating and not just a number: ★ 4.6.
import type { CSSProperties } from 'react';

export function Rating({ value, empty = '–', size = 14, style, count }: { value: number | null | undefined; empty?: string; size?: number; style?: CSSProperties; count?: number }) {
  const has = value != null && !Number.isNaN(Number(value));
  return (
    <span
      className="ui-rating"
      aria-label={has ? `Rated ${Number(value).toFixed(1)} out of 5${count ? `, from ${count}` : ''}` : 'Not rated yet'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.3), fontWeight: 700, whiteSpace: 'nowrap', color: has ? 'var(--color-warning-text, #fbbf24)' : 'var(--color-text-secondary, #9ca3af)', ...style }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ flex: 'none' }}>
        <path
          d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"
          fill={has ? 'var(--color-warning, #f59e0b)' : 'none'}
          stroke={has ? 'var(--color-warning, #f59e0b)' : 'currentColor'}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span aria-hidden>{has ? Number(value).toFixed(1) : empty}</span>
    </span>
  );
}
