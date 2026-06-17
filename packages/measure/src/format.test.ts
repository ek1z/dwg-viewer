import { describe, it, expect } from 'vitest';
import { formatLength, formatArea, formatAngle } from './format.js';
import type { DrawingUnits } from '@dwg-viewer/dxf-core';

const MM: DrawingUnits = { code: 4, name: 'mm', metersPerUnit: 0.001 };
const UNITLESS: DrawingUnits = { code: 0, name: 'unitless', metersPerUnit: null };

describe('formatLength', () => {
  it('appends the unit label', () => {
    expect(formatLength(12.5, MM)).toBe('12.5 mm');
  });

  it('omits the label when unitless', () => {
    expect(formatLength(12.5, UNITLESS)).toBe('12.5');
  });

  it('omits the label when units are null', () => {
    expect(formatLength(7, null)).toBe('7');
  });
});

describe('formatArea', () => {
  it('uses a squared unit label', () => {
    expect(formatArea(4, MM)).toBe('4 mm²');
  });

  it('omits the label when unitless', () => {
    expect(formatArea(4, UNITLESS)).toBe('4');
  });
});

describe('formatAngle', () => {
  it('converts radians to degrees', () => {
    expect(formatAngle(Math.PI / 2)).toBe('90°');
  });

  it('rounds to two fractional digits', () => {
    expect(formatAngle(Math.PI / 3)).toBe('60°');
  });
});
