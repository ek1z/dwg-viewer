import { describe, expect, it } from 'vitest';
import { decodeDxf, resolveDxfEncoding, sniffDxfHeader } from './encoding.js';

/** Build a minimal DXF HEADER section in the given single-byte code page. */
function header(vars: { acadver?: string; codepage?: string }): string {
  const lines = ['0', 'SECTION', '2', 'HEADER'];
  if (vars.acadver) lines.push('9', '$ACADVER', '1', vars.acadver);
  if (vars.codepage) lines.push('9', '$DWGCODEPAGE', '3', vars.codepage);
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\r\n');
}

/** Encode a string to raw bytes in a single-byte (latin1/cp1252-compatible) page. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

describe('sniffDxfHeader', () => {
  it('reads $ACADVER and $DWGCODEPAGE', () => {
    expect(sniffDxfHeader(latin1Bytes(header({ acadver: 'AC1018', codepage: 'ANSI_1252' })))).toEqual({
      acadver: 'AC1018',
      codepage: 'ANSI_1252',
    });
  });

  it('returns empty info when the header lacks both vars', () => {
    expect(sniffDxfHeader(latin1Bytes(header({})))).toEqual({});
  });
});

describe('resolveDxfEncoding', () => {
  it('maps legacy DWG code pages to TextDecoder labels', () => {
    expect(resolveDxfEncoding({ codepage: 'ANSI_1252', acadver: 'AC1018' }, 'dwg')).toBe('windows-1252');
    expect(resolveDxfEncoding({ codepage: 'ANSI_1250' }, 'dwg')).toBe('windows-1250');
    expect(resolveDxfEncoding({ codepage: 'UTF8' }, 'dwg')).toBe('utf-8');
  });

  it('treats native DXF 2007+ as UTF-8 regardless of $DWGCODEPAGE', () => {
    expect(resolveDxfEncoding({ codepage: 'ANSI_1252', acadver: 'AC1021' }, 'dxf')).toBe('utf-8');
    expect(resolveDxfEncoding({ codepage: 'ANSI_1252', acadver: 'AC1032' }, 'dxf')).toBe('utf-8');
  });

  it('does not let the version override the code page for DWG-derived DXF', () => {
    // libredwg may emit an old version tag yet write bytes in its declared page.
    expect(resolveDxfEncoding({ codepage: 'ANSI_1252', acadver: 'AC1021' }, 'dwg')).toBe('windows-1252');
  });

  it('falls back to windows-1252 for legacy files with no declared code page', () => {
    expect(resolveDxfEncoding({ acadver: 'AC1015' }, 'dxf')).toBe('windows-1252');
    expect(resolveDxfEncoding({ acadver: 'AC1015' }, 'dwg')).toBe('windows-1252');
  });

  it('defaults to UTF-8 when there is no header info at all', () => {
    expect(resolveDxfEncoding({}, 'dxf')).toBe('utf-8');
  });

  it('falls back to windows-1252 for an unknown code page name', () => {
    expect(resolveDxfEncoding({ codepage: 'ANSI_9999' }, 'dwg')).toBe('windows-1252');
  });
});

describe('decodeDxf', () => {
  it('decodes Nordic text from a windows-1252 DWG-derived document', () => {
    // 'Kynä' with ä as the lone 0xE4 byte, as libredwg emits for ANSI_1252.
    const bytes = latin1Bytes(header({ acadver: 'AC1018', codepage: 'ANSI_1252' }) + '\r\nKyn\xe4');
    expect(decodeDxf(bytes, 'dwg')).toContain('Kynä');
  });

  it('recovers bytes a bare UTF-8 decode would mojibake (regression guard)', () => {
    const bytes = latin1Bytes(header({ acadver: 'AC1018', codepage: 'ANSI_1252' }) + '\r\nKyn\xe4');
    // The bug: a bare UTF-8 decode produces the replacement char, not 'ä'.
    expect(new TextDecoder().decode(bytes)).not.toContain('Kynä');
    // The fix: code-page-aware decode recovers it.
    expect(decodeDxf(bytes, 'dwg')).toContain('Kynä');
  });

  it('decodes real UTF-8 bytes for a modern native DXF', () => {
    const text = header({ acadver: 'AC1027', codepage: 'ANSI_1252' }) + '\r\nKynä';
    const bytes = new TextEncoder().encode(text);
    expect(decodeDxf(bytes, 'dxf')).toContain('Kynä');
  });
});
