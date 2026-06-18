/**
 * Byte → text decoding for DXF input.
 *
 * DXF/DWG are not always UTF-8. Legacy drawings (AutoCAD ≤2004) store text in a
 * single-byte code page named by the `$DWGCODEPAGE` header — `ANSI_1252`
 * (windows-1252) for Western/Nordic files — so characters like `å ä ö` are lone
 * high bytes. Blindly decoding those as UTF-8 (what `File.text()` and a bare
 * `TextDecoder()` do) turns each into U+FFFD. We therefore decode from raw
 * bytes, picking the encoding from the header.
 *
 * Two sources, two rules (see {@link resolveDxfEncoding}):
 *  - native DXF files follow the spec — AutoCAD 2007+ (`$ACADVER` ≥ AC1021) is
 *    always UTF-8 regardless of `$DWGCODEPAGE`;
 *  - DXF emitted by libredwg from a DWG is written in exactly the code page it
 *    declares, so we trust `$DWGCODEPAGE` verbatim there.
 */

/** Source of the DXF bytes; selects the encoding-resolution rule. */
export type DxfSource = 'dxf' | 'dwg';

/**
 * DXF `$DWGCODEPAGE` string values → WHATWG `TextDecoder` labels. AutoCAD writes
 * `ANSI_<cp>` for Windows code pages, `ISO8859-<n>` / `DOS<n>` for others, and
 * `UTF8` for Unicode. Anything not listed falls back to windows-1252.
 */
const CODE_PAGE_LABELS: Record<string, string> = {
  UTF8: 'utf-8',
  'UTF-8': 'utf-8',
  US_ASCII: 'utf-8',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  ANSI_874: 'windows-874',
  ANSI_932: 'shift-jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  'ISO8859-1': 'iso-8859-1',
  'ISO8859-2': 'iso-8859-2',
  'ISO8859-3': 'iso-8859-3',
  'ISO8859-4': 'iso-8859-4',
  'ISO8859-5': 'iso-8859-5',
  'ISO8859-6': 'iso-8859-6',
  'ISO8859-7': 'iso-8859-7',
  'ISO8859-8': 'iso-8859-8',
  'ISO8859-9': 'iso-8859-9',
};

/** Numeric `$ACADVER` value (e.g. `AC1021` → 1021) at/after which DXF is UTF-8. */
const UTF8_ACADVER = 1021; // AutoCAD 2007

/** Default for legacy/unknown single-byte drawings — the common real-world page. */
const DEFAULT_LABEL = 'windows-1252';

/** Header variables read from the start of a DXF document. */
export interface DxfHeaderInfo {
  /** `$ACADVER` value, e.g. `AC1018`, if present. */
  acadver?: string;
  /** `$DWGCODEPAGE` value, e.g. `ANSI_1252`, if present. */
  codepage?: string;
}

function toUint8(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * Read `$ACADVER` and `$DWGCODEPAGE` from the HEADER section. Both values are
 * ASCII, so we scan the leading bytes as latin1 (1:1 byte→char) and never risk a
 * mis-decode here. In DXF a header variable appears as its name on one line, a
 * group code on the next, and the value on the one after (`$DWGCODEPAGE` / `3` /
 * `ANSI_1252`).
 */
export function sniffDxfHeader(input: ArrayBuffer | Uint8Array): DxfHeaderInfo {
  const bytes = toUint8(input);
  // The HEADER section is first; 64 KiB is far more than enough to reach both vars.
  const slice = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const head = new TextDecoder('latin1').decode(slice);
  const lines = head.split(/\r?\n/);
  const info: DxfHeaderInfo = {};
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const name = lines[i]!.trim();
    if (name === '$ACADVER') info.acadver = lines[i + 2]!.trim();
    else if (name === '$DWGCODEPAGE') info.codepage = lines[i + 2]!.trim();
    if (info.acadver && info.codepage) break;
  }
  return info;
}

/** Parse the numeric part of an `$ACADVER` string (`AC1018` → 1018), or NaN. */
function acadverNumber(acadver: string | undefined): number {
  const m = acadver?.match(/AC(\d+)/i);
  return m ? parseInt(m[1]!, 10) : NaN;
}

/**
 * Choose a `TextDecoder` label for the given header and source.
 *
 * Native DXF files obey the spec: 2007+ is UTF-8 no matter what `$DWGCODEPAGE`
 * says. DWG-derived DXF is decoded strictly by the code page libredwg declares
 * (its byte output is consistent with that page), so the version is ignored.
 */
export function resolveDxfEncoding(info: DxfHeaderInfo, source: DxfSource): string {
  const codepage = info.codepage?.toUpperCase();

  if (source === 'dxf' && acadverNumber(info.acadver) >= UTF8_ACADVER) {
    return 'utf-8';
  }
  if (codepage) {
    return CODE_PAGE_LABELS[codepage] ?? DEFAULT_LABEL;
  }
  // No declared code page: trust the spec for known-modern files, else assume
  // the legacy default. A file with no version info at all is most likely a
  // hand-authored modern DXF, so prefer UTF-8 there.
  if (acadverNumber(info.acadver) >= UTF8_ACADVER) return 'utf-8';
  return info.acadver ? DEFAULT_LABEL : 'utf-8';
}

/**
 * Decode raw DXF bytes to text using the encoding declared in the header. Use
 * this instead of `File.text()` / `new TextDecoder().decode()` so non-UTF-8
 * drawings render their text correctly.
 */
export function decodeDxf(input: ArrayBuffer | Uint8Array, source: DxfSource): string {
  const bytes = toUint8(input);
  const label = resolveDxfEncoding(sniffDxfHeader(bytes), source);
  return new TextDecoder(label).decode(bytes);
}
