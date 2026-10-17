export type ThemeChoice = 'system' | 'light' | 'dark';

const THEME_EVENT = 'erp:theme';

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    localStorage.setItem('erp-theme', choice);
  } catch {}
  // Keeps the top bar and My profile in step when either one changes it.
  window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_EVENT, { detail: choice }));
}

export function onThemeChange(fn: (t: ThemeChoice) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<ThemeChoice>).detail);
  window.addEventListener(THEME_EVENT, h);
  return () => window.removeEventListener(THEME_EVENT, h);
}

export function applyMotion(reduced: boolean) {
  const root = document.documentElement;
  if (reduced) root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
  try {
    localStorage.setItem('erp-motion', reduced ? 'reduced' : 'full');
  } catch {}
}

export function readTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem('erp-theme');
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {}
  return 'system';
}
