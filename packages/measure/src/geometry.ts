import type { Vec2 } from '@dwg-viewer/dxf-core';

/**
 * Measurement primitives. Everything operates on plain float64 `Vec2` world
 * coordinates — never on f32 GPU positions (plan §5) — so measured values are
 * exact regardless of the renderer's precision strategy.
 */

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Total length of an open polyline through `points`. */
export function polylineLength(points: ReadonlyArray<Vec2>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!);
  return total;
}

/**
 * Absolute area of the polygon formed by `points` (implicitly closed) via the
 * shoelace formula. Returns 0 for degenerate input (< 3 points).
 */
export function polygonArea(points: ReadonlyArray<Vec2>): number {
  const n = points.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Perimeter of the closed polygon through `points`. */
export function polygonPerimeter(points: ReadonlyArray<Vec2>): number {
  const n = points.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) total += distance(points[i]!, points[(i + 1) % n]!);
  return total;
}

/**
 * Unsigned angle at `vertex` between the rays to `a` and `b`, in radians [0, π].
 * Uses atan2 of the cross/dot magnitudes for numerical stability near 0 and π.
 */
export function angleAt(vertex: Vec2, a: Vec2, b: Vec2): number {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  const dot = ax * bx + ay * by;
  const cross = ax * by - ay * bx;
  return Math.atan2(Math.abs(cross), dot);
}

/** Closest point to `p` on the segment a→b (clamped to the segment endpoints). */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * Intersection point of segments (p1,p2) and (p3,p4) when they actually cross
 * within both spans; null for parallel/collinear or non-overlapping segments.
 */
export function segmentIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = p4.x - p3.x;
  const sy = p4.y - p3.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null; // parallel or collinear
  const qpx = p3.x - p1.x;
  const qpy = p3.y - p1.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  const EPS = 1e-9;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: p1.x + t * rx, y: p1.y + t * ry };
}

/** Centroid (vertex average) of a set of points; for label placement. */
export function centroid(points: ReadonlyArray<Vec2>): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}
