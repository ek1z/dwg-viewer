import type { DrawingUnits } from '@dwg-viewer/dxf-core';

/**
 * Unit-aware formatting of measured values. Distances and areas are in drawing
 * units (the same units the scene coordinates use); the label comes from the
 * drawing's `$INSUNITS`. Unitless drawings get a bare number.
 */

function unitLabel(units: DrawingUnits | null): string {
  if (!units || units.name === 'unitless') return '';
  return units.name;
}

function num(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function formatLength(value: number, units: DrawingUnits | null): string {
  const label = unitLabel(units);
  return label ? `${num(value)} ${label}` : num(value);
}

export function formatArea(value: number, units: DrawingUnits | null): string {
  const label = unitLabel(units);
  return label ? `${num(value)} ${label}²` : num(value);
}

export function formatAngle(radians: number): string {
  const deg = (radians * 180) / Math.PI;
  return `${deg.toLocaleString(undefined, { maximumFractionDigits: 2 })}°`;
}
