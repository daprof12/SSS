'use client';

import type { ThemeChoice } from './theme';

const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Outline icons, 24-unit grid (Design Brief: outline set, filled when active). */
export function ThemeIcon({ choice, active }: { choice: ThemeChoice; active?: boolean }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (choice === 'light')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" fill={active ? 'currentColor' : 'none'} />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
    );
  if (choice === 'dark')
    return (
      <svg {...common}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill={active ? 'currentColor' : 'none'} />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="2" y="3" width="20" height="14" rx="2" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.18 : 0} />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/**
 * Theme picker. `compact` shows icons only (top bar); the label stays as the
 * accessible name and tooltip. Full mode shows icon + word (My profile).
 */
export function ThemeSwitch({ value, onChange, compact }: { value: ThemeChoice; onChange: (t: ThemeChoice) => void; compact?: boolean }) {
  return (
    <div className={`segmented ${compact ? 'icons' : ''}`} role="radiogroup" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          aria-pressed={value === t}
          aria-label={compact ? `${LABEL[t]} theme` : undefined}
          title={compact ? `${LABEL[t]} theme` : undefined}
          onClick={() => onChange(t)}
        >
          <ThemeIcon choice={t} active={value === t} />
          {!compact && <span>{LABEL[t]}</span>}
        </button>
      ))}
    </div>
  );
}
