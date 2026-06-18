import { ShapeUtils, Vector2 } from 'three';
import type { HatchEdge, HatchLoop, HatchPatternLine, Vec2 } from '@dwg-viewer/dxf-core';
import { tessellateArc, tessellateEllipse, tessellatePolyline, tessellateSpline } from './tessellate.js';
import { expandDashed } from './dash.js';

/**
 * HATCH geometry generation, in the entity's *local* (OCS) coordinate space —
 * the engine applies the entity transform and rebasing offset afterwards, like
 * every other primitive (see `engine.appendEntity`).
 *
 * Two outputs:
 *  - {@link solidHatchTriangles} fills the boundary (with islands) as triangles.
 *  - {@link patternHatchRuns} draws the pattern definition lines, clipped to the
 *    boundary by a scanline pass and dashed per the pattern.
 *
 * Boundaries are filled with the even-odd rule across all loops, matching the
 * default ("normal") AutoCAD hatch style.
 */

/** Skip a pattern family that would emit more than this many parallel lines. */
const MAX_HATCH_LINES = 4000;
/** Hard cap on stroked runs across all families, so a pathological hatch can't blow up memory. */
const MAX_HATCH_RUNS = 200_000;
const EPS = 1e-9;

/** Tessellate every boundary loop into a closed ring of local-space points. */
export function tessellateHatchLoops(loops: ReadonlyArray<HatchLoop>): Vec2[][] {
  const rings: Vec2[][] = [];
  for (const loop of loops) {
    const ring = loop.kind === 'polyline' ? polylineRing(loop) : edgesRing(loop.edges);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function polylineRing(loop: { vertices: ReadonlyArray<Vec2 & { bulge?: number }> }): Vec2[] {
  // Hatch polyline boundaries are implicitly closed; tessellate as a closed run
  // and drop the duplicated closing point (rings here close implicitly).
  return dropClosingDuplicate(tessellatePolyline(loop.vertices, true));
}

function edgesRing(edges: ReadonlyArray<HatchEdge>): Vec2[] {
  const pts: Vec2[] = [];
  for (const edge of edges) {
    const seg = tessellateEdge(edge);
    // Skip a point that merely repeats the previous edge's endpoint.
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > EPS) pts.push(p);
    }
  }
  return dropClosingDuplicate(pts);
}

function tessellateEdge(edge: HatchEdge): Vec2[] {
  switch (edge.type) {
    case 'line':
      return [edge.a, edge.b];
    case 'arc': {
      const pts = tessellateArc(edge.center.x, edge.center.y, edge.radius, edge.startAngle, edge.endAngle);
      return edge.ccw ? pts : reverseArc(edge);
    }
    case 'ellipse': {
      const pts = tessellateEllipse(
        edge.center.x,
        edge.center.y,
        edge.majorAxis.x,
        edge.majorAxis.y,
        edge.axisRatio,
        edge.startAngle,
        edge.endAngle,
      );
      if (edge.ccw) return pts;
      return tessellateEllipse(
        edge.center.x,
        edge.center.y,
        edge.majorAxis.x,
        edge.majorAxis.y,
        edge.axisRatio,
        edge.endAngle,
        edge.startAngle,
      ).reverse();
    }
    case 'spline':
      return tessellateSpline(edge.degree, edge.controlPoints, edge.knots, edge.closed);
  }
}

/** A clockwise arc edge: sample CCW the other way, then reverse to keep traversal order. */
function reverseArc(edge: Extract<HatchEdge, { type: 'arc' }>): Vec2[] {
  return tessellateArc(edge.center.x, edge.center.y, edge.radius, edge.endAngle, edge.startAngle).reverse();
}

function dropClosingDuplicate(ring: Vec2[]): Vec2[] {
  if (ring.length >= 2) {
    const a = ring[0]!;
    const b = ring[ring.length - 1]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) <= EPS) return ring.slice(0, -1);
  }
  return ring;
}

/**
 * Triangulate the filled region as a flat list of local-space triangle vertices
 * (`[x0,y0, x1,y1, x2,y2, …]`, 6 numbers per triangle). Loops are classified
 * into outer contours and holes by even-odd containment, so islands are cut out.
 */
export function solidHatchTriangles(rings: ReadonlyArray<Vec2[]>): number[] {
  const out: number[] = [];
  for (const group of classifyRings(rings)) {
    const contour = group.outer.map((p) => new Vector2(p.x, p.y));
    const holes = group.holes.map((h) => h.map((p) => new Vector2(p.x, p.y)));
    let faces: number[][];
    try {
      faces = ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue; // a self-intersecting ring can throw; skip rather than abort the load
    }
    const verts = [contour, ...holes].flat();
    for (const face of faces) {
      const va = verts[face[0]!]!;
      const vb = verts[face[1]!]!;
      const vc = verts[face[2]!]!;
      out.push(va.x, va.y, vb.x, vb.y, vc.x, vc.y);
    }
  }
  return out;
}

interface RingGroup {
  outer: Vec2[];
  holes: Vec2[][];
}

/**
 * Partition rings into outer/hole groups by even-odd nesting: a ring nested
 * inside an odd number of others is a hole, cut from its immediate (smallest
 * containing) outer. Exact for the common one-level case (region + islands) and
 * degrades gracefully for deeper nesting.
 */
function classifyRings(rings: ReadonlyArray<Vec2[]>): RingGroup[] {
  const depth = rings.map((r, i) =>
    rings.reduce((d, other, j) => (j !== i && pointInRing(r[0]!, other) ? d + 1 : d), 0),
  );
  const areas = rings.map(ringArea);
  const groups: RingGroup[] = rings.map((r) => ({ outer: r, holes: [] }));
  const isOuter = depth.map((d) => d % 2 === 0);

  for (let i = 0; i < rings.length; i++) {
    if (isOuter[i]) continue; // i is a hole
    // Immediate container: the smallest-area outer ring that contains it.
    let parent = -1;
    for (let j = 0; j < rings.length; j++) {
      if (j === i || !isOuter[j] || !pointInRing(rings[i]![0]!, rings[j]!)) continue;
      if (parent === -1 || areas[j]! < areas[parent]!) parent = j;
    }
    if (parent !== -1) groups[parent]!.holes.push(rings[i]!);
  }
  return groups.filter((_, i) => isOuter[i]);
}

/** Ray-cast point-in-polygon (implicit close). */
function pointInRing(p: Vec2, ring: ReadonlyArray<Vec2>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

function ringArea(ring: ReadonlyArray<Vec2>): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j]!.x + ring[i]!.x) * (ring[j]!.y - ring[i]!.y);
  }
  return Math.abs(a) / 2;
}

/**
 * Generate the stroked pattern lines clipped to the boundary, as open polylines
 * in local space (dashes already expanded into separate runs). Each pattern
 * definition line becomes a family of parallel scanlines; the AutoCAD "double"
 * flag adds a perpendicular copy of every family.
 */
export function patternHatchRuns(
  rings: ReadonlyArray<Vec2[]>,
  pattern: ReadonlyArray<HatchPatternLine>,
  double: boolean,
): Vec2[][] {
  if (!rings.length) return [];
  const runs: Vec2[][] = [];
  for (const line of pattern) {
    appendFamily(runs, rings, line);
    // The "double" flag mirrors the family at 90°, keeping the same spacing.
    if (double) appendFamily(runs, rings, { ...line, angle: line.angle + Math.PI / 2 });
    if (runs.length > MAX_HATCH_RUNS) break;
  }
  return runs;
}

function appendFamily(out: Vec2[][], rings: ReadonlyArray<Vec2[]>, line: HatchPatternLine): void {
  const spacing = Math.abs(line.spacing);
  if (!(spacing > EPS)) return; // degenerate family (lines coincide)

  const ux = Math.cos(line.angle);
  const uy = Math.sin(line.angle);
  // Perpendicular unit vector.
  const vx = -uy;
  const vy = ux;
  const bx = line.base.x;
  const by = line.base.y;

  // Project every ring point into (U along line, V across) relative to the base.
  let vMin = Infinity;
  let vMax = -Infinity;
  const uv: Array<Array<{ u: number; v: number }>> = rings.map((ring) =>
    ring.map((p) => {
      const dx = p.x - bx;
      const dy = p.y - by;
      const v = dx * vx + dy * vy;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
      return { u: dx * ux + dy * uy, v };
    }),
  );
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return;

  const nStart = Math.ceil(vMin / spacing - EPS);
  const nEnd = Math.floor(vMax / spacing + EPS);
  if (nEnd - nStart > MAX_HATCH_LINES) return; // too dense to be useful (scale mismatch)

  const dashes = line.dashes.length ? [...line.dashes] : null;
  const crossings: number[] = [];
  for (let n = nStart; n <= nEnd; n++) {
    const vn = n * spacing;
    crossings.length = 0;
    for (const ring of uv) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        // Half-open straddle test: counts each shared vertex once, drops edges
        // that lie along the scanline.
        if ((a.v <= vn && b.v > vn) || (b.v <= vn && a.v > vn)) {
          const t = (vn - a.v) / (b.v - a.v);
          crossings.push(a.u + t * (b.u - a.u));
        }
      }
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const ua = crossings[k]!;
      const ub = crossings[k + 1]!;
      if (ub - ua <= EPS) continue;
      const p0 = { x: bx + ua * ux + vn * vx, y: by + ua * uy + vn * vy };
      const p1 = { x: bx + ub * ux + vn * vx, y: by + ub * uy + vn * vy };
      if (dashes) {
        for (const run of expandDashed([p0, p1], dashes, 1, false)) out.push(run);
      } else {
        out.push([p0, p1]);
      }
      if (out.length > MAX_HATCH_RUNS) return;
    }
  }
}
