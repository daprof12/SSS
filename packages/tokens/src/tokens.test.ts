import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { renderCss, renderDart } from './render';
import { colorRoles, contrastPairs, palettes, type ThemeName } from './tokens';

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#FFFFFF', '#0891B2')).toBeCloseTo(3.68, 2);
  });
});

describe.each<ThemeName>(['dark', 'light'])('%s palette', (theme) => {
  const p = palettes[theme];

  it('defines every colour role', () => {
    for (const role of colorRoles) expect(p[role], role).toBeTruthy();
  });

  it.each(contrastPairs)('$fg on $bg passes AA ($note)', ({ fg, bg, large }) => {
    const ratio = contrastRatio(p[fg], p[bg]);
    expect(ratio, `${theme}: ${fg} ${p[fg]} on ${bg} ${p[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      large ? 3 : 4.5,
    );
  });
});

describe('renderers', () => {
  it('emits both themes, OS fallback and reduced motion in CSS', () => {
    const css = renderCss();
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('--color-action-primary: #E11D48;');
    expect(css).toContain('--motion-ambient-duration: 0ms;');
  });

  it('emits Dart colours with alpha for overlays', () => {
    const dart = renderDart();
    expect(dart).toContain('static const Color emergency = Color(0xFFFF3B5C);');
    expect(dart).toMatch(/static const Color overlay = Color\(0xA3000000\);/);
  });
});
