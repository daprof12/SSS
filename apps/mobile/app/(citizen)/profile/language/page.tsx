'use client';

import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { api } from '@/lib/client';

const LANGS = [
  ['en', 'English', 'English'],
  ['pcm', 'Pidgin', 'Naija Pidgin'],
  ['ha', 'Hausa', 'Hausa'],
  ['yo', 'Yoruba', 'Yorùbá'],
  ['ig', 'Igbo', 'Igbo'],
] as const;

/** Language (PRD: English, Hausa, Yoruba, Igbo, Pidgin). Saved to the account; screens follow as translations land. */
export default function Language() {
  const [locale, setLocale] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  useEffect(() => {
    api<{ preferences: { locale: string } }>('/me')
      .then((m) => setLocale(m.preferences.locale))
      .catch(() => setLocale('en'));
  }, []);
  const pick = async (code: string, name: string) => {
    const prev = locale;
    setLocale(code);
    try {
      await api('/me/preferences', { method: 'PATCH', body: JSON.stringify({ locale: code }) });
      document.documentElement.lang = code;
      setToast(`Language set to ${name}.`);
    } catch {
      setLocale(prev);
      setToast('Could not save. Try again.');
    }
  };
  return (
    <main className="app">
      <Header title="Language" back="/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        Saved to your account. Screens are in English for now; the other languages follow as translations are checked. You can write notes and messages in any language.
      </p>
      <div role="radiogroup" aria-label="Language">
        {LANGS.map(([code, name, native]) => (
          <button key={code} className="choice" type="button" role="radio" aria-checked={locale === code} aria-pressed={locale === code} onClick={() => pick(code, name)} style={{ minHeight: 64 }}>
            <span className="radio-dot" data-on={locale === code} />
            <span className="grow">
              <strong>{name}</strong>
              {native !== name && <span className="sub">{native}</span>}
            </span>
          </button>
        ))}
      </div>
      <Toast msg={toast} />
    </main>
  );
}
