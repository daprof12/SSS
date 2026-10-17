import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCss, renderDart } from './render';
import * as tokens from './tokens';

const out = join(__dirname, '..', 'dist');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'tokens.css'), renderCss());
writeFileSync(join(out, 'tokens.dart'), renderDart());
writeFileSync(
  join(out, 'tokens.json'),
  JSON.stringify(
    {
      palettes: tokens.palettes,
      type: tokens.type,
      radius: tokens.radius,
      space: tokens.space,
      touch: tokens.touch,
      motion: tokens.motion,
      breakpoints: tokens.breakpoints,
    },
    null,
    2,
  ),
);
console.log(`tokens written to ${out}`);
