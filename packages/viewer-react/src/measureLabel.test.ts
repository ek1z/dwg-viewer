import { describe, it, expect } from 'vitest';
import { measurementValue } from './measureLabel.js';
import type { DrawingUnits } from '@dwg-viewer/dxf-core';

const MM: DrawingUnits = { code: 4, name: 'mm', metersPerUnit: 0.001 };

describe('measurementValue', () => {
  it('returns empty until a distance has two points', () => {
    expect(measurementValue('distance', [{ x: 0, y: 0 }], MM)).toBe('');
  });

  it('formats a two-point distance', () => {
    expect(
      measurementValue('distance', [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ], MM),
    ).toBe('5 mm');
  });

  it('accumulates a multi-segment distance', () => {
    expect(
      measurementValue('distance', [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ], MM),
    ).toBe('7 mm');
  });

  it('shows a segment length while an area has only two points', () => {
    expect(
      measurementValue('area', [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ], MM),
    ).toBe('5 mm');
  });

  it('formats area and perimeter once closed', () => {
    expect(
      measurementValue('area', [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ], MM),
    ).toBe('12 mm² · 14 mm');
  });

  it('formats an angle at the middle vertex', () => {
    expect(
      measurementValue('angle', [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1 },
      ], MM),
    ).toBe('90°');
  });

  it('returns empty for an incomplete angle', () => {
    expect(
      measurementValue('angle', [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ], MM),
    ).toBe('');
  });
});
