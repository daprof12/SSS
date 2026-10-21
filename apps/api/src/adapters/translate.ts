// Statement translation (B7, TRD "AI English record"): the person's words in their language → an
// English working record, with a confidence and the words the model is unsure of (names, places,
// times). Production calls the LLM provider; the record is advisory until the person signs it.

export interface TranslateResult {
  english: string;
  /** 0..1 */
  confidence: number;
  /** Words to double-check before signing. */
  flagged: string[];
  /** Language detected when the person chose Auto. */
  detected: string;
}

export interface TranslateAdapter {
  readonly name: string;
  translate(text: string, language: string): Promise<TranslateResult>;
}

export const TRANSLATE = Symbol('TRANSLATE');

const NAMES: Record<string, string> = { yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo', pcm: 'Pidgin', en: 'English' };

/**
 * Development stand-in, deterministic and honest about itself: English stays as it is; other
 * languages come back marked as a machine draft for the person to correct. Capitalised words
 * (likely names and places) and numbers (times, plates) are flagged.
 */
export class MockTranslateAdapter implements TranslateAdapter {
  readonly name = 'mock';
  async translate(text: string, language: string): Promise<TranslateResult> {
    const detected = language === 'auto' ? (/\b(the|and|is|was|they|we)\b/i.test(text) ? 'en' : 'pcm') : language;
    const flagged = [...new Set((text.match(/\b([A-Z][a-z]{2,}|\d[\d:.]*)\b/g) ?? []).filter((w) => !/^(The|And|I|We|They|He|She|It|There)$/.test(w)))].slice(0, 12);
    if (detected === 'en') return { english: text.trim(), confidence: 0.98, flagged: [], detected };
    return {
      english: `[Machine draft from ${NAMES[detected] ?? detected}; check every line] ${text.trim()}`,
      confidence: 0.64,
      flagged,
      detected,
    };
  }
}
