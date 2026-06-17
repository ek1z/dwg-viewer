/**
 * Pure helpers for rendering DXF TEXT/MTEXT with `troika-three-text`.
 *
 * SHX fonts are not embedded in DXF, so faithful glyphs are impossible (plan
 * §3/§5 "Text rendering"); we substitute a bundled TrueType font and render it
 * as SDF geometry sized in world units. Everything here is framework- and
 * three.js-free so it stays unit-testable; the engine owns the actual `Text`
 * objects.
 */

import type { TextHAlign, TextVAlign } from '@dwg-viewer/dxf-core';

/**
 * Cap height as a fraction of the font em box. DXF `height` is the capital
 * letter height, whereas troika's `fontSize` is the full em box, so the engine
 * divides authored height by this ratio to make rendered caps match. ~0.72 is
 * the cap-height/UPM ratio of Liberation Sans (the bundled substitution font,
 * metric-compatible with Arial).
 */
export const CAP_HEIGHT_RATIO = 0.72;

/** troika `anchorX` keyword for a DXF horizontal alignment. */
export function anchorX(h: TextHAlign): 'left' | 'center' | 'right' {
  return h;
}

/**
 * troika `anchorY` keyword for a DXF vertical alignment. DXF anchors relative to
 * the cap/baseline, so we use cap-relative troika keywords rather than the
 * em-box `'top'`/`'bottom'` (which would drift once `fontSize` is scaled up by
 * `CAP_HEIGHT_RATIO`). `baseline` (the DXF default) anchors at the first line's
 * baseline.
 */
export function anchorY(v: TextVAlign): 'top-cap' | 'middle' | 'bottom' | 'top-baseline' {
  switch (v) {
    case 'top':
      return 'top-cap';
    case 'middle':
      return 'middle';
    case 'bottom':
      return 'bottom';
    case 'baseline':
      return 'top-baseline';
  }
}

/** Inline MTEXT codes (after a backslash) that take a `;`-terminated argument. */
const MTEXT_ARG_CODES = new Set(['f', 'F', 'H', 'W', 'Q', 'T', 'A', 'C', 'p']);
/** Inline MTEXT toggle codes (after a backslash) with no argument. */
const MTEXT_TOGGLE_CODES = new Set(['L', 'l', 'O', 'o', 'K', 'k', 'N']);

/**
 * Strip MTEXT inline formatting and decode escapes to plain, possibly
 * multi-line, text. We render content, not styling: font/height/colour/oblique
 * runs are dropped, `\P` becomes a newline, stacked fractions collapse to
 * `num/den`, and `\U+XXXX` / brace grouping are resolved.
 */
function decodeMText(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) {
        out += '\\';
        i += 1;
        continue;
      }
      // Escaped literals.
      if (next === '\\' || next === '{' || next === '}') {
        out += next;
        i += 2;
        continue;
      }
      if (next === 'P' || next === 'X') {
        out += '\n';
        i += 2;
        continue;
      }
      if (next === '~') {
        out += ' '; // non-breaking space
        i += 2;
        continue;
      }
      // \U+XXXX unicode escape.
      if (next === 'U' && s[i + 2] === '+') {
        const hex = s.slice(i + 3, i + 7);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 7;
          continue;
        }
      }
      // Stacked fraction \S<num>(^|/|#)<den>; → num/den.
      if (next === 'S') {
        const end = s.indexOf(';', i + 2);
        const body = end === -1 ? s.slice(i + 2) : s.slice(i + 2, end);
        out += body.replace(/[\^#/]/, '/');
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      // Property runs that carry a ;-terminated argument.
      if (MTEXT_ARG_CODES.has(next)) {
        const end = s.indexOf(';', i + 2);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      // Argument-less toggles.
      if (MTEXT_TOGGLE_CODES.has(next)) {
        i += 2;
        continue;
      }
      // Unknown escape: drop the backslash, keep the character.
      out += next;
      i += 2;
      continue;
    }
    // Grouping braces carry styling scope only.
    if (ch === '{' || ch === '}') {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Decode DTEXT/MTEXT `%%` control codes (degree, diameter, plus/minus, etc.). */
function decodeControlCodes(s: string): string {
  return s
    .replace(/%%[oOuU]/g, '') // over/underline toggles — no plain-text effect
    .replace(/%%[dD]/g, '°') // degree
    .replace(/%%[cC]/g, '⌀') // diameter ⌀
    .replace(/%%[pP]/g, '±') // plus/minus
    .replace(/%%(\d{3})/g, (_m, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/%%%/g, '%');
}

/**
 * Decode a TEXT/MTEXT raw string to the plain text to render. MTEXT inline
 * formatting is stripped first, then `%%` control codes (which appear in both).
 */
export function decodeText(raw: string, isMText: boolean): string {
  return decodeControlCodes(isMText ? decodeMText(raw) : raw);
}
