import type { DrawingUnits } from './types.js';

/**
 * $INSUNITS code → unit label and metres-per-unit. Covers the codes that turn
 * up in real drawings; exotic ones (microinches, parsecs, …) fall back to a
 * label with a best-effort factor. Code 0 is unitless: measurement reads in
 * raw drawing units.
 */
const UNITS: Record<number, { name: string; metersPerUnit: number | null }> = {
  0: { name: 'unitless', metersPerUnit: null },
  1: { name: 'in', metersPerUnit: 0.0254 },
  2: { name: 'ft', metersPerUnit: 0.3048 },
  3: { name: 'mi', metersPerUnit: 1609.344 },
  4: { name: 'mm', metersPerUnit: 0.001 },
  5: { name: 'cm', metersPerUnit: 0.01 },
  6: { name: 'm', metersPerUnit: 1 },
  7: { name: 'km', metersPerUnit: 1000 },
  8: { name: 'µin', metersPerUnit: 0.0254e-6 },
  9: { name: 'mil', metersPerUnit: 0.0254e-3 },
  10: { name: 'yd', metersPerUnit: 0.9144 },
  11: { name: 'Å', metersPerUnit: 1e-10 },
  12: { name: 'nm', metersPerUnit: 1e-9 },
  13: { name: 'µm', metersPerUnit: 1e-6 },
  14: { name: 'dm', metersPerUnit: 0.1 },
  15: { name: 'dam', metersPerUnit: 10 },
  16: { name: 'hm', metersPerUnit: 100 },
  17: { name: 'Gm', metersPerUnit: 1e9 },
  18: { name: 'au', metersPerUnit: 1.495978707e11 },
  19: { name: 'ly', metersPerUnit: 9.4607304725808e15 },
  20: { name: 'pc', metersPerUnit: 3.0856775814913673e16 },
};

export function resolveUnits(insUnits: number | undefined): DrawingUnits {
  const code = typeof insUnits === 'number' ? insUnits : 0;
  const entry = UNITS[code] ?? { name: 'unitless', metersPerUnit: null };
  return { code, name: entry.name, metersPerUnit: entry.metersPerUnit };
}
