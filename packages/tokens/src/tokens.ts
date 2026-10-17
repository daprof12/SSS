// Single source of truth for design tokens. Design Brief values, with the
// accessibility fixes from document/UX Gap Analysis.md §6:
// - text-on-surface variants for signal, success, emergency and warning in light mode
// - a separate primary-action fill, because white on dark-mode emergency (#FF3B5C) is 3.48:1

export type ThemeName = 'dark' | 'light';

export const colorRoles = [
  'bg',
  'surface',
  'surfaceRaised',
  'surfaceSunken',
  'overlay',
  'textPrimary',
  'textSecondary',
  'textDisabled',
  'divider',
  'focusRing',
  // Emergency: SOS, critical status. Same hue family in every mode.
  'emergency',
  'emergencyText',
  'emergencySoft',
  'onEmergency',
  // Primary action buttons that carry normal-size text.
  'actionPrimary',
  'onActionPrimary',
  'signal',
  'signalText',
  'signalSoft',
  'onSignal',
  'success',
  'successText',
  'successSoft',
  'warning',
  'warningText',
  'warningSoft',
  'skeleton',
] as const;

export type ColorRole = (typeof colorRoles)[number];
export type Palette = Record<ColorRole, string>;

export const palettes: Record<ThemeName, Palette> = {
  dark: {
    bg: '#000000',
    surface: '#121212',
    surfaceRaised: '#1E1E1E',
    surfaceSunken: '#0A0A0A',
    overlay: 'rgba(0, 0, 0, 0.64)',
    textPrimary: '#FFFFFF',
    textSecondary: '#A1A1AA',
    textDisabled: '#5C5C66',
    divider: '#2A2A2E',
    focusRing: '#22D3EE',
    emergency: '#FF3B5C',
    emergencyText: '#FF3B5C',
    emergencySoft: '#2B1117',
    onEmergency: '#FFFFFF',
    actionPrimary: '#E11D48',
    onActionPrimary: '#FFFFFF',
    signal: '#22D3EE',
    signalText: '#22D3EE',
    signalSoft: '#0E2A30',
    onSignal: '#000000',
    success: '#34D399',
    successText: '#34D399',
    successSoft: '#0F2A22',
    warning: '#FBBF24',
    warningText: '#FBBF24',
    warningSoft: '#2A2210',
    skeleton: '#1E1E1E',
  },
  light: {
    bg: '#FFFFFF',
    surface: '#F5F5F7',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#EDEDF0',
    overlay: 'rgba(17, 17, 17, 0.48)',
    textPrimary: '#111111',
    textSecondary: '#5C5C66',
    textDisabled: '#A1A1AA',
    divider: '#E4E4E7',
    focusRing: '#0E7490',
    emergency: '#E11D48',
    emergencyText: '#BE123C',
    emergencySoft: '#FFE4E9',
    onEmergency: '#FFFFFF',
    actionPrimary: '#E11D48',
    onActionPrimary: '#FFFFFF',
    signal: '#0E7490',
    signalText: '#0E7490',
    signalSoft: '#E0F7FB',
    onSignal: '#FFFFFF',
    success: '#059669',
    successText: '#047857',
    successSoft: '#DCFCE9',
    warning: '#B45309',
    warningText: '#92400E',
    warningSoft: '#FEF3C7',
    skeleton: '#EDEDF0',
  },
};

/**
 * Pairs that must pass WCAG 2.2 AA. `large` pairs only carry text of
 * at least 18.66px bold or 24px regular (3:1); all others need 4.5:1.
 */
export const contrastPairs: Array<{ fg: ColorRole; bg: ColorRole; large?: boolean; note: string }> = [
  { fg: 'textPrimary', bg: 'bg', note: 'body text' },
  { fg: 'textPrimary', bg: 'surface', note: 'card text' },
  { fg: 'textPrimary', bg: 'surfaceRaised', note: 'modal text' },
  { fg: 'textSecondary', bg: 'bg', note: 'captions' },
  { fg: 'textSecondary', bg: 'surface', note: 'card captions' },
  { fg: 'textSecondary', bg: 'surfaceRaised', note: 'modal captions' },
  { fg: 'emergencyText', bg: 'bg', note: 'critical status text' },
  { fg: 'emergencyText', bg: 'surface', note: 'critical status on cards' },
  { fg: 'onEmergency', bg: 'emergency', large: true, note: 'SOS label (40px extra-bold)' },
  { fg: 'onActionPrimary', bg: 'actionPrimary', note: 'primary button labels' },
  { fg: 'signalText', bg: 'bg', note: 'links' },
  { fg: 'signalText', bg: 'surface', note: 'links on cards' },
  { fg: 'onSignal', bg: 'signal', note: 'signal button labels' },
  { fg: 'successText', bg: 'bg', note: 'resolved, verified' },
  { fg: 'successText', bg: 'surface', note: 'resolved on cards' },
  { fg: 'successText', bg: 'successSoft', note: 'verified chip' },
  { fg: 'warningText', bg: 'bg', note: 'pending, low trust' },
  { fg: 'warningText', bg: 'surface', note: 'pending on cards' },
  { fg: 'warningText', bg: 'warningSoft', note: 'warning banner' },
  { fg: 'emergencyText', bg: 'emergencySoft', note: 'critical banner' },
  { fg: 'signalText', bg: 'signalSoft', note: 'info banner' },
];

export const type = {
  fontFamily: "'Plus Jakarta Sans', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  size: { xs: 12, sm: 14, md: 16, lg: 20, xl: 28, xxl: 40 },
  weight: { regular: 400, semibold: 600, bold: 700, extrabold: 800 },
  lineHeight: { tight: 1.2, normal: 1.45 },
} as const;

export const radius = { card: 12, sheet: 20, pill: 999 } as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const;

export const touch = { min: 48, typeTile: 72, sos: 72 } as const;

export const breakpoints = { phone: 360, tablet: 768, desktop: 1200 } as const;

/** Motion tokens — UX Gap Analysis §5. */
export const motion = {
  instant: { durationMs: 100, easing: 'linear' },
  fast: { durationMs: 200, easing: 'cubic-bezier(0, 0, 0.2, 1)' },
  sheetEnter: { durationMs: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  sheetExit: { durationMs: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  emphasis: { durationMs: 400, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' },
  ambient: { durationMs: 2000, easing: 'ease-in-out' },
  /** Under reduced motion, every transform becomes an opacity fade of at most this. */
  reducedMaxMs: 150,
} as const;

export type MotionToken = keyof Omit<typeof motion, 'reducedMaxMs'>;
