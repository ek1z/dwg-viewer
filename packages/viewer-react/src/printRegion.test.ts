import { describe, expect, it } from 'vitest';
import type { DrawingUnits } from '@dwg-viewer/dxf-core';
import { computePrintScale } from './printRegion.js';

const mm: DrawingUnits = { code: 4, name: 'mm', metersPerUnit: 0.001 };
const unitless: DrawingUnits = { code: 0, name: 'unitless', metersPerUnit: null };

// A4 landscape printable area with a 10 mm margin: 277 mm × 190 mm.
const A4_W = 297;
const A4_H = 210;
const MARGIN = 10;

describe('computePrintScale', () => {
  it('returns null without real-world units', () => {
    expect(computePrintScale(unitless, 1000, 500, A4_W, A4_H, MARGIN)).toBeNull();
    expect(computePrintScale(null, 1000, 500, A4_W, A4_H, MARGIN)).toBeNull();
  });

  it('reports a reduction ratio when the region is larger than the page', () => {
    // 10 m × 5 m drawing (mm units) → bound by width: 10000 / 277 ≈ 36.
    expect(computePrintScale(mm, 10000, 5000, A4_W, A4_H, MARGIN)).toBe('≈ 1:36');
  });

  it('reports an enlargement ratio when the region is smaller than the page', () => {
    // 50 mm × 30 mm drawing → bound by width: 277 / 50 ≈ 5.5 → 5.5:1.
    expect(computePrintScale(mm, 50, 30, A4_W, A4_H, MARGIN)).toBe('≈ 5.5:1');
  });

  it('uses whichever dimension reduces most (fit-to-page)', () => {
    // Tall region: height 20000 mm bounds it more than width. 20000 / 190 ≈ 105.
    expect(computePrintScale(mm, 1000, 20000, A4_W, A4_H, MARGIN)).toBe('≈ 1:105');
  });
});
