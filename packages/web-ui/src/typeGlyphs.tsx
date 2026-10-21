// Report-type outline glyphs on a 24 grid, the same shapes as the phone app's icon set, so a map pin
// shows what kind of report it is.
import type { ReactNode } from 'react';

export const TYPE_GLYPHS: Record<string, ReactNode> = {
  fire: <path d="M12 2c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8z" />,
  robbery: <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z" />,
  medical: <path d="M12 5v14M5 12h14" />,
  kidnapping: (
    <>
      <circle cx="12" cy="7" r="3" />
      <path d="M6 21v-1a6 6 0 0 1 12 0v1" />
    </>
  ),
  riot: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  violence: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  accident: (
    <>
      <path d="M5 17h14v-5l-2-5H7l-2 5v5z" />
      <circle cx="8" cy="17" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  other: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3} />,
};

/** Pin colour per report type, so fire, medical and police reports read apart at a glance. */
export const TYPE_COLOURS: Record<string, string> = {
  fire: '#ea580c',
  medical: '#0d9488',
  accident: '#ca8a04',
  robbery: '#dc2626',
  kidnapping: '#dc2626',
  riot: '#dc2626',
  violence: '#dc2626',
  other: '#6b7280',
};
