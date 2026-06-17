import { describe, it, expect } from 'vitest';
import {
  distance,
  polylineLength,
  polygonArea,
  polygonPerimeter,
  angleAt,
  closestPointOnSegment,
  segmentIntersection,
  centroid,
} from './geometry.js';

describe('distance', () => {
  it('is the Euclidean norm', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('stays exact at large survey coordinates (float64)', () => {
    const a = { x: 1_000_000, y: 2_000_000 };
    const b = { x: 1_000_003, y: 2_000_004 };
    expect(distance(a, b)).toBeCloseTo(5, 9);
  });
});

describe('polylineLength', () => {
  it('sums consecutive segments', () => {
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 14 },
      ]),
    ).toBe(15);
  });

  it('is 0 for fewer than two points', () => {
    expect(polylineLength([{ x: 1, y: 1 }])).toBe(0);
  });
});

describe('polygonArea', () => {
  it('computes a unit square', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ]),
    ).toBe(4);
  });

  it('is orientation-independent (absolute)', () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ];
    const cw = [...ccw].reverse();
    expect(polygonArea(cw)).toBe(polygonArea(ccw));
  });

  it('is 0 for degenerate polygons', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });
});

describe('polygonPerimeter', () => {
  it('closes the ring', () => {
    expect(
      polygonPerimeter([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ]),
    ).toBe(12); // 3 + 4 + 5
  });
});

describe('angleAt', () => {
  it('measures a right angle', () => {
    const a = angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 });
    expect(a).toBeCloseTo(Math.PI / 2, 12);
  });

  it('measures a straight angle', () => {
    const a = angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 });
    expect(a).toBeCloseTo(Math.PI, 12);
  });

  it('is unsigned (never exceeds π)', () => {
    const a = angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -0.0001 });
    expect(a).toBeLessThanOrEqual(Math.PI);
    expect(a).toBeGreaterThanOrEqual(0);
  });
});

describe('closestPointOnSegment', () => {
  it('projects onto the interior', () => {
    expect(closestPointOnSegment({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual({
      x: 1,
      y: 0,
    });
  });

  it('clamps past the endpoints', () => {
    expect(closestPointOnSegment({ x: -5, y: 3 }, { x: 0, y: 0 }, { x: 2, y: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('handles a zero-length segment', () => {
    expect(closestPointOnSegment({ x: 9, y: 9 }, { x: 1, y: 2 }, { x: 1, y: 2 })).toEqual({
      x: 1,
      y: 2,
    });
  });
});

describe('segmentIntersection', () => {
  it('finds a proper crossing', () => {
    const x = segmentIntersection(
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    );
    expect(x).toEqual({ x: 0, y: 0 });
  });

  it('returns null when segments miss', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }),
    ).toBeNull();
  });

  it('returns null for parallel segments', () => {
    expect(
      segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }),
    ).toBeNull();
  });
});

describe('centroid', () => {
  it('averages the vertices', () => {
    expect(
      centroid([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 1, y: 3 },
      ]),
    ).toEqual({ x: 1, y: 1 });
  });
});
