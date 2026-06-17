/**
 * Supplemental scan for per-layer defaults that `dxf-parser` drops.
 *
 * The parser's LAYER table reader only keeps the name (2), color/visibility (62)
 * and flags (70); it silently discards the layer's default **linetype** (group 6)
 * and **lineweight** (group 370). Those defaults are exactly where most drawings
 * keep their dashed-line and pen-width information — entities typically inherit
 * them via "ByLayer" rather than setting them per object. So we re-scan the raw
 * DXF text for just the LAYER table and recover those two fields.
 *
 * This works on the DXF *text*, so it covers the DWG path too (DWG is converted
 * to DXF text before parsing), and it keeps `dxf-parser` unforked behind the
 * adapter boundary.
 */

export interface LayerDefault {
  /** Layer's default linetype name (DXF group 6), or undefined if absent. */
  linetype?: string;
  /** Layer's default lineweight in 1/100 mm (DXF group 370), or undefined if absent. */
  lineweightRaw?: number;
}

/**
 * Parse the LAYER table out of raw DXF text, returning per-layer defaults keyed
 * by layer name. Robust to the loose formatting real DXF uses: code/value pairs
 * on alternating lines, arbitrary leading whitespace, CRLF or LF endings.
 *
 * Only the LAYER table is walked; everything else is skipped cheaply.
 */
export function scanLayerDefaults(dxfText: string): Map<string, LayerDefault> {
  const out = new Map<string, LayerDefault>();
  const lines = dxfText.split(/\r\n|\r|\n/);

  // Locate the start of the LAYER table: a `2`/`LAYER` group inside a TABLE.
  let i = findLayerTable(lines);
  if (i < 0) return out;

  let current: LayerDefault | null = null;
  let currentName: string | null = null;

  const flush = () => {
    if (currentName !== null && current) out.set(currentName, current);
    current = null;
    currentName = null;
  };

  for (; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim();
    const value = lines[i + 1]!.trim();

    if (code === '0') {
      if (value === 'LAYER') {
        flush();
        current = {};
        continue;
      }
      // ENDTAB / next table / anything else terminates the LAYER table.
      flush();
      break;
    }
    if (!current) continue; // codes before the first LAYER record (table header)

    switch (code) {
      case '2':
        currentName = value;
        break;
      case '6':
        current.linetype = value;
        break;
      case '370': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) current.lineweightRaw = n;
        break;
      }
    }
  }
  flush();
  return out;
}

/**
 * Index of the first code line of the first LAYER record (the `0`/`LAYER` pair),
 * or -1. We scan for the LAYER table header (`2`/`LAYER` directly after a
 * `0`/`TABLE`) and return the position just past it.
 */
function findLayerTable(lines: string[]): number {
  for (let i = 0; i + 3 < lines.length; i += 1) {
    if (
      lines[i]!.trim() === '0' &&
      lines[i + 1]!.trim() === 'TABLE' &&
      lines[i + 2]!.trim() === '2' &&
      lines[i + 3]!.trim() === 'LAYER'
    ) {
      return i + 4;
    }
  }
  return -1;
}
