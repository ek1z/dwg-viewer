import { describe, it, expect } from 'vitest';
import type { HatchLoop, HatchPatternLine, Vec2 } from '@dwg-viewer/dxf-core';
import { patternHatchRuns, solidHatchTriangles, tessellateHatchLoops } from './hatch.js';

/** Build a closed polyline loop from raw points. */
function polyLoop(points: Array<[number, number]>): HatchLoop {
  return { kind: 'polyline', closed: true, vertices: points.map(([x, y]) => ({ x, y })) };
}

const SQUARE: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

/** Summed area of a flat triangle-vertex list (`[x,y, x,y, x,y, …]`). */
function triangleArea(tris: number[]): number {
  let area = 0;
  for (let i = 0; i + 5 < tris.length; i += 6) {
    const ax = tris[i]!;
    const ay = tris[i + 1]!;
    const bx = tris[i + 2]!;
    const by = tris[i + 3]!;
    const cx = tris[i + 4]!;
    const cy = tris[i + 5]!;
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return area;
}

describe('tessellateHatchLoops', () => {
  it('produces a closed ring without a duplicated closing point', () => {
    const rings = tessellateHatchLoops([polyLoop(SQUARE)]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('tessellates an arc-edge boundary into a polygon', () => {
    const loop: HatchLoop = {
      kind: 'edges',
      edges: [
        { type: 'arc', center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI * 2, ccw: true },
      ],
    };
    const rings = tessellateHatchLoops([loop]);
    expect(rings[0]!.length).toBeGreaterThan(8);
  });
});

describe('solidHatchTriangles', () => {
  it('fills a square with its full area', () => {
    const rings = tessellateHatchLoops([polyLoop(SQUARE)]);
    expect(triangleArea(solidHatchTriangles(rings))).toBeCloseTo(100, 5);
  });

  it('cuts an island out of the fill (even-odd)', () => {
    const inner: Array<[number, number]> = [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
    ];
    const rings = tessellateHatchLoops([polyLoop(SQUARE), polyLoop(inner)]);
    // 10×10 outer minus 4×4 hole = 84.
    expect(triangleArea(solidHatchTriangles(rings))).toBeCloseTo(84, 5);
  });
});

describe('patternHatchRuns', () => {
  const horizontal: HatchPatternLine = {
    angle: 0,
    base: { x: 0, y: 0 },
    spacing: 1,
    along: 0,
    dashes: [],
  };

  it('clips a horizontal line family to the boundary', () => {
    const rings = tessellateHatchLoops([polyLoop(SQUARE)]);
    const runs = patternHatchRuns(rings, [horizontal], false);
    // Half-open scanline: y = 0..9 are drawn, y = 10 (top edge) is excluded so a
    // shared boundary isn't double-stroked → 10 lines.
    expect(runs).toHaveLength(10);
    for (const run of runs) {
      expect(run).toHaveLength(2);
      for (const p of run) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-9);
        expect(p.x).toBeLessThanOrEqual(10 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(-1e-9);
        expect(p.y).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
    // Each interior line spans the full 10-unit width.
    const widths = runs.map((r) => Math.hypot(r[1]!.x - r[0]!.x, r[1]!.y - r[0]!.y));
    expect(Math.max(...widths)).toBeCloseTo(10, 5);
  });

  it('skips a degenerate family with zero spacing', () => {
    const rings = tessellateHatchLoops([polyLoop(SQUARE)]);
    const degenerate: HatchPatternLine = { ...horizontal, spacing: 0 };
    expect(patternHatchRuns(rings, [degenerate], false)).toHaveLength(0);
  });

  it('does not blow up on an absurdly dense family', () => {
    const rings = tessellateHatchLoops([polyLoop(SQUARE)]);
    const dense: HatchPatternLine = { ...horizontal, spacing: 1e-6 };
    expect(patternHatchRuns(rings, [dense], false)).toHaveLength(0);
  });

  it('crosses two families for a crosshatch', () => {
    const rings = tessellateHatchLoops([polyLoop(SQUARE)]);
    const vertical: HatchPatternLine = { ...horizontal, angle: Math.PI / 2 };
    const runs = patternHatchRuns(rings, [horizontal, vertical], false);
    expect(runs.length).toBeGreaterThan(11);
  });
});
