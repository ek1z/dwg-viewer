import { describe, expect, it } from 'vitest';
import { anchorX, anchorY, decodeText } from './text.js';

describe('decodeText — DTEXT control codes', () => {
  it('decodes degree, diameter and plus/minus', () => {
    expect(decodeText('90%%d', false)).toBe('90°');
    expect(decodeText('%%c50', false)).toBe('⌀50');
    expect(decodeText('%%p0.5', false)).toBe('±0.5');
  });

  it('strips under/overline toggles and decodes %%nnn / %%%', () => {
    expect(decodeText('%%uABC%%u', false)).toBe('ABC');
    expect(decodeText('%%037', false)).toBe('%'); // 3-digit ASCII 37 = '%'
    expect(decodeText('50%%%', false)).toBe('50%');
  });

  it('leaves plain text untouched', () => {
    expect(decodeText('PLAN VIEW', false)).toBe('PLAN VIEW');
  });
});

describe('decodeText — MTEXT inline codes', () => {
  it('turns \\P into newlines and strips group braces', () => {
    expect(decodeText('Line1\\PLine2', true)).toBe('Line1\nLine2');
    expect(decodeText('{Hello}', true)).toBe('Hello');
  });

  it('drops formatting runs but keeps their content', () => {
    expect(decodeText('\\fArial|b0;Bold off', true)).toBe('Bold off');
    expect(decodeText('\\H2.5x;\\C1;Big red', true)).toBe('Big red');
    expect(decodeText('{\\L underlined \\l}plain', true)).toBe(' underlined plain');
  });

  it('decodes \\U+XXXX, escaped braces and stacked fractions', () => {
    expect(decodeText('30\\U+00B0', true)).toBe('30°');
    expect(decodeText('a\\{b\\}c', true)).toBe('a{b}c');
    expect(decodeText('\\S1/2;', true)).toBe('1/2');
    expect(decodeText('\\S3^4;', true)).toBe('3/4');
  });

  it('still resolves %% control codes inside MTEXT', () => {
    expect(decodeText('R%%c100\\Pwide', true)).toBe('R⌀100\nwide');
  });
});

describe('anchor mapping', () => {
  it('maps horizontal alignment one-to-one', () => {
    expect(anchorX('left')).toBe('left');
    expect(anchorX('center')).toBe('center');
    expect(anchorX('right')).toBe('right');
  });

  it('maps vertical alignment to cap/baseline-relative keywords', () => {
    expect(anchorY('baseline')).toBe('top-baseline');
    expect(anchorY('top')).toBe('top-cap');
    expect(anchorY('middle')).toBe('middle');
    expect(anchorY('bottom')).toBe('bottom');
  });
});
