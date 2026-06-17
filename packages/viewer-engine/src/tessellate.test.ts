import { describe, it, expect } from 'vitest';
import { tessellateArc, tessellatePolyline, tessellateSpline } from './tessellate.js';

describe('tessellateArc', () => {
  it('produces points on the circle', () => {
    const pts = tessellateArc(0, 0, 10, 0, Math.PI * 2);
    expect(pts.length).toBeGreaterThan(8);
    for (const p of pts) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 5);
    }
  });

  it('starts and ends at the requested angles', () => {
    const pts = tessellateArc(0, 0, 5, 0, Math.PI / 2);
    expect(pts[0]!.x).toBeCloseTo(5);
    expect(pts[0]!.y).toBeCloseTo(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(0);
    expect(pts[pts.length - 1]!.y).toBeCloseTo(5);
  });
});

describe('tessellatePolyline', () => {
  it('passes straight segments through unchanged', () => {
    const pts = tessellatePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false);
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it('expands a bulge into an arc', () => {
    // Semicircle bulge (=1) between (0,0) and (10,0).
    const pts = tessellatePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }], false);
    expect(pts.length).toBeGreaterThan(3);
    // Apex should bow to y≈5 (radius 5 semicircle).
    const maxY = Math.max(...pts.map((p) => Math.abs(p.y)));
    expect(maxY).toBeCloseTo(5, 1);
  });

  it('closes the ring when closed', () => {
    const open = tessellatePolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], false);
    const closed = tessellatePolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], true);
    expect(closed.length).toBe(open.length + 1);
    expect(closed[closed.length - 1]).toEqual({ x: 0, y: 0 });
  });
});

describe('tessellateSpline', () => {
  it('falls back to control points for malformed knots', () => {
    const cps = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }];
    const pts = tessellateSpline(3, cps, [], false);
    expect(pts).toEqual(cps);
  });

  it('interpolates a valid cubic spline near its control hull', () => {
    const cps = [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }];
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const pts = tessellateSpline(3, cps, knots, false);
    expect(pts.length).toBeGreaterThan(8);
    // Endpoints clamp to first/last control point.
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[0]!.y).toBeCloseTo(0);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(4);
    expect(pts[pts.length - 1]!.y).toBeCloseTo(0);
  });
});
