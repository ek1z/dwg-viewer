import { describe, it, expect } from 'vitest';
import { expandDashed } from './dash.js';
import type { Vec2 } from '@dwg-viewer/dxf-core';

/** Total stroked length across all returned dash runs. */
function strokedLength(runs: Vec2[][]): number {
  let total = 0;
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      total += Math.hypot(run[i + 1]!.x - run[i]!.x, run[i + 1]!.y - run[i]!.y);
    }
  }
  return total;
}

const LINE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
];

describe('expandDashed', () => {
  it('returns a single solid run for an empty pattern', () => {
    const runs = expandDashed(LINE, [], 1, false);
    expect(runs).toEqual([LINE]);
  });

  it('returns solid when the scale is non-positive', () => {
    const runs = expandDashed(LINE, [5, -5], 0, false);
    expect(runs).toEqual([LINE]);
  });

  it('returns solid for an all-pen-down pattern', () => {
    const runs = expandDashed(LINE, [5, 5], 1, false);
    expect(runs).toEqual([LINE]);
  });

  it('breaks a line into dashes for a dash/gap pattern', () => {
    // 5 down, 5 up → period 10 over length 100 → 10 dashes.
    const runs = expandDashed(LINE, [5, -5], 1, false);
    expect(runs.length).toBe(10);
    // Each dash is 5 long, all on the x axis.
    for (const run of runs) {
      expect(run).toHaveLength(2);
      expect(run[0]!.y).toBe(0);
      expect(Math.abs(run[1]!.x - run[0]!.x)).toBeCloseTo(5);
    }
    expect(strokedLength(runs)).toBeCloseTo(50); // half pen-down
  });

  it('honors the scale factor', () => {
    // scale 2 → period 20 over 100 → 5 dashes of length 10.
    const runs = expandDashed(LINE, [5, -5], 2, false);
    expect(runs.length).toBe(5);
    expect(strokedLength(runs)).toBeCloseTo(50);
  });

  it('renders dots (0) as tiny visible dashes', () => {
    // dot, gap → each dot is a 2-point run with near-zero length.
    const runs = expandDashed(LINE, [0, -5], 1, false);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toHaveLength(2);
      expect(Math.abs(run[1]!.x - run[0]!.x)).toBeLessThan(1);
    }
  });

  it('flows the pattern around corners (multi-segment dash)', () => {
    // An L-shape; a long dash should span the corner, keeping both legs.
    const L: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const runs = expandDashed(L, [30, -1], 1, false);
    // First dash (length 30) covers both 10-unit legs (20) + into nothing more,
    // so it should include the corner vertex.
    const first = runs[0]!;
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.some((p) => p.x === 10 && p.y === 0)).toBe(true);
  });

  it('closes the ring when closed is set', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // Solid closed → one run that returns to the start (perimeter 40).
    const runs = expandDashed(square, [], 1, true);
    expect(runs).toHaveLength(1);
    expect(strokedLength(runs)).toBeCloseTo(40);
  });

  it('falls back to solid when a pattern would blow up the segment count', () => {
    // Period 0.001 over length 100 → 100k dashes; guarded to a single solid run.
    const runs = expandDashed(LINE, [0.0005, -0.0005], 1, false);
    expect(runs).toEqual([LINE]);
  });
});
