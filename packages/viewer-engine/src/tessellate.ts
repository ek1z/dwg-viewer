import type { Vec2 } from '@dwg-viewer/dxf-core';

/**
 * Curve tessellation: parametric entities → polylines (arrays of local-space
 * points). All output is in the entity's own coordinate space; the engine
 * applies the entity transform and rebasing offset afterwards.
 *
 * Smoothness is governed by a relative chord tolerance (sagitta / radius), so
 * circles of any size get a comparable silhouette. This is a fixed tolerance,
 * not zoom-adaptive — adaptive re-tessellation on zoom is a later refinement
 * (see plan §5: faceting on zoom-in).
 */
const CHORD_TOL_RATIO = 0.0006;
const MAX_ARC_SEGMENTS = 512;

function arcSegmentCount(span: number): number {
  const maxAngle = 2 * Math.acos(Math.max(0, 1 - CHORD_TOL_RATIO));
  return Math.min(MAX_ARC_SEGMENTS, Math.max(1, Math.ceil(Math.abs(span) / maxAngle)));
}

/** Points along an arc, inclusive of both endpoints. `end` may wrap past `start`. */
export function tessellateArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): Vec2[] {
  let span = endAngle - startAngle;
  // Normalize a CCW span into (0, 2π]; a full circle keeps 2π.
  if (span <= 0) span += Math.PI * 2;
  const segs = arcSegmentCount(span);
  const out: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = startAngle + (span * i) / segs;
    out.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return out;
}

/** Points along a (possibly partial) ellipse. Angles parameterize the unit circle pre-skew. */
export function tessellateEllipse(
  cx: number,
  cy: number,
  majorX: number,
  majorY: number,
  axisRatio: number,
  startAngle: number,
  endAngle: number,
): Vec2[] {
  let span = endAngle - startAngle;
  if (span <= 0) span += Math.PI * 2;
  const major = Math.hypot(majorX, majorY);
  const segs = arcSegmentCount(span) * (major > 0 ? 1 : 1);
  const rot = Math.atan2(majorY, majorX);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const a = major;
  const b = major * axisRatio;
  const out: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = startAngle + (span * i) / segs;
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    out.push({ x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos });
  }
  return out;
}

/** Arc bulge between two polyline vertices (DXF bulge = tan(θ/4)). */
function bulgeArc(p1: Vec2, p2: Vec2, bulge: number): Vec2[] {
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chord === 0 || theta === 0) return [p2];
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  // Perpendicular from chord midpoint to the arc center.
  const dx = (p2.x - p1.x) / chord;
  const dy = (p2.y - p1.y) / chord;
  const sagittaDir = bulge > 0 ? 1 : -1;
  const h = radius * Math.cos(Math.abs(theta) / 2) * sagittaDir;
  const cx = mid.x - dy * h;
  const cy = mid.y + dx * h;
  const start = Math.atan2(p1.y - cy, p1.x - cx);
  const segs = arcSegmentCount(theta);
  const out: Vec2[] = [];
  for (let i = 1; i <= segs; i++) {
    const a = start + (theta * i) / segs;
    out.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return out;
}

export function tessellatePolyline(
  vertices: ReadonlyArray<Vec2 & { bulge?: number }>,
  closed: boolean,
): Vec2[] {
  if (vertices.length === 0) return [];
  const out: Vec2[] = [{ x: vertices[0]!.x, y: vertices[0]!.y }];
  const last = vertices.length - 1;
  for (let i = 0; i < last; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    if (a.bulge) out.push(...bulgeArc(a, b, a.bulge));
    else out.push({ x: b.x, y: b.y });
  }
  if (closed) {
    const a = vertices[last]!;
    const b = vertices[0]!;
    if (a.bulge) out.push(...bulgeArc(a, b, a.bulge));
    else out.push({ x: b.x, y: b.y });
  }
  return out;
}

/**
 * NURBS curve via de Boor's algorithm. Falls back to a polyline through the
 * control points when the knot vector is malformed, and to a Catmull-Rom-ish
 * sampling through fit points when only fit points were authored.
 */
export function tessellateSpline(
  degree: number,
  controlPoints: ReadonlyArray<Vec2>,
  knots: ReadonlyArray<number>,
  closed: boolean,
  fitPoints?: ReadonlyArray<Vec2>,
  weights?: ReadonlyArray<number>,
): Vec2[] {
  if ((!controlPoints || controlPoints.length <= degree) && fitPoints && fitPoints.length >= 2) {
    return [...fitPoints];
  }
  const n = controlPoints.length - 1;
  const validKnots = knots.length === n + degree + 2;
  if (n < 1 || degree < 1 || !validKnots) {
    return controlPoints.length ? [...controlPoints] : fitPoints ? [...fitPoints] : [];
  }

  const w = weights && weights.length === controlPoints.length ? weights : null;
  const tMin = knots[degree]!;
  const tMax = knots[n + 1]!;
  const samples = Math.min(MAX_ARC_SEGMENTS, Math.max(controlPoints.length * 8, 32));
  const out: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = tMin + ((tMax - tMin) * i) / samples;
    out.push(deBoor(degree, controlPoints, knots, w, Math.min(t, tMax - 1e-9)));
  }
  if (closed && out.length) out.push({ x: out[0]!.x, y: out[0]!.y });
  return out;
}

function deBoor(
  degree: number,
  cps: ReadonlyArray<Vec2>,
  knots: ReadonlyArray<number>,
  weights: ReadonlyArray<number> | null,
  t: number,
): Vec2 {
  const n = cps.length - 1;
  // Find knot span k such that knots[k] <= t < knots[k+1].
  let k = degree;
  while (k < n && knots[k + 1]! <= t) k++;

  // Homogeneous control points (x*w, y*w, w).
  const d: { x: number; y: number; w: number }[] = [];
  for (let j = 0; j <= degree; j++) {
    const idx = k - degree + j;
    const cp = cps[idx]!;
    const wj = weights ? weights[idx]! : 1;
    d.push({ x: cp.x * wj, y: cp.y * wj, w: wj });
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1]! - knots[i]!;
      const alpha = denom === 0 ? 0 : (t - knots[i]!) / denom;
      const prev = d[j - 1]!;
      const cur = d[j]!;
      d[j] = {
        x: (1 - alpha) * prev.x + alpha * cur.x,
        y: (1 - alpha) * prev.y + alpha * cur.y,
        w: (1 - alpha) * prev.w + alpha * cur.w,
      };
    }
  }
  const res = d[degree]!;
  return res.w !== 0 ? { x: res.x / res.w, y: res.y / res.w } : { x: res.x, y: res.y };
}
