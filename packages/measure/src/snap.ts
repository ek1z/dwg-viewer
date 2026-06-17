import Flatbush from 'flatbush';
import type { Vec2 } from '@dwg-viewer/dxf-core';
import type { SnapKind, SnapResult } from './types.js';
import { SNAP_PRIORITY } from './types.js';
import { closestPointOnSegment, distance, segmentIntersection } from './geometry.js';

/** Snap point kinds that are stored explicitly (vs. derived on the fly). */
type StoredKind = 'endpoint' | 'midpoint' | 'center';
const STORED_KINDS: StoredKind[] = ['endpoint', 'midpoint', 'center'];

/**
 * Above this many segment candidates near the cursor we skip the O(k²)
 * intersection pass — in dense areas it is both slow and rarely useful, while
 * endpoint/midpoint/nearest snaps remain available.
 */
const MAX_INTERSECTION_CANDIDATES = 64;

/**
 * Accumulates snap geometry (in true world float64 coordinates) for one scene,
 * then freezes it into a {@link SnapIndex}. The renderer feeds this while it
 * tessellates, so curves contribute the same segments that are drawn.
 */
export class SnapBuilder {
  private readonly px: number[] = [];
  private readonly py: number[] = [];
  private readonly pk: number[] = [];
  /** Flattened segment endpoints: ax, ay, bx, by, ax, ay, … */
  private readonly seg: number[] = [];

  addPoint(x: number, y: number, kind: StoredKind): void {
    this.px.push(x);
    this.py.push(y);
    this.pk.push(STORED_KINDS.indexOf(kind));
  }

  addSegment(ax: number, ay: number, bx: number, by: number): void {
    this.seg.push(ax, ay, bx, by);
  }

  build(): SnapIndex {
    return new SnapIndex(this.px, this.py, this.pk, this.seg);
  }
}

interface Candidate {
  point: Vec2;
  kind: SnapKind;
  dist: number;
}

/**
 * Spatial index over a scene's snap geometry. Endpoints, midpoints and centers
 * are indexed directly; intersections are computed lazily from the handful of
 * segments near the cursor (all-pairs intersection is never precomputed —
 * plan §4). `query` converts a pixel tolerance, supplied as a world radius by
 * the caller, into the best snap under the cursor.
 */
export class SnapIndex {
  private readonly pointTree: Flatbush | null;
  private readonly segTree: Flatbush | null;

  constructor(
    private readonly px: ReadonlyArray<number>,
    private readonly py: ReadonlyArray<number>,
    private readonly pk: ReadonlyArray<number>,
    private readonly seg: ReadonlyArray<number>,
  ) {
    if (px.length > 0) {
      const t = new Flatbush(px.length);
      for (let i = 0; i < px.length; i++) t.add(px[i]!, py[i]!, px[i]!, py[i]!);
      t.finish();
      this.pointTree = t;
    } else {
      this.pointTree = null;
    }

    const segCount = seg.length / 4;
    if (segCount > 0) {
      const t = new Flatbush(segCount);
      for (let i = 0; i < segCount; i++) {
        const ax = seg[i * 4]!;
        const ay = seg[i * 4 + 1]!;
        const bx = seg[i * 4 + 2]!;
        const by = seg[i * 4 + 3]!;
        t.add(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
      }
      t.finish();
      this.segTree = t;
    } else {
      this.segTree = null;
    }
  }

  /** True once there is any geometry to snap to. */
  get isEmpty(): boolean {
    return this.pointTree === null && this.segTree === null;
  }

  /**
   * Best snap within `radius` (world units) of `p`, or null. When multiple
   * candidates qualify, the higher-priority kind wins (endpoint > intersection
   * > midpoint > center > nearest), ties broken by distance.
   */
  query(p: Vec2, radius: number): SnapResult | null {
    const candidates: Candidate[] = [];

    if (this.pointTree) {
      const ids = this.pointTree.search(p.x - radius, p.y - radius, p.x + radius, p.y + radius);
      for (const id of ids) {
        const pt = { x: this.px[id]!, y: this.py[id]! };
        const d = distance(p, pt);
        if (d <= radius) candidates.push({ point: pt, kind: STORED_KINDS[this.pk[id]!]!, dist: d });
      }
    }

    if (this.segTree) {
      const ids = this.segTree.search(p.x - radius, p.y - radius, p.x + radius, p.y + radius);
      const segs = ids.map((id) => ({
        a: { x: this.seg[id * 4]!, y: this.seg[id * 4 + 1]! },
        b: { x: this.seg[id * 4 + 2]!, y: this.seg[id * 4 + 3]! },
      }));
      for (const s of segs) {
        const cp = closestPointOnSegment(p, s.a, s.b);
        const d = distance(p, cp);
        if (d <= radius) candidates.push({ point: cp, kind: 'nearest', dist: d });
      }
      if (segs.length <= MAX_INTERSECTION_CANDIDATES) {
        for (let i = 0; i < segs.length; i++) {
          for (let j = i + 1; j < segs.length; j++) {
            const x = segmentIntersection(segs[i]!.a, segs[i]!.b, segs[j]!.a, segs[j]!.b);
            if (!x) continue;
            const d = distance(p, x);
            if (d <= radius) candidates.push({ point: x, kind: 'intersection', dist: d });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const pa = SNAP_PRIORITY[a.kind];
      const pb = SNAP_PRIORITY[b.kind];
      return pa !== pb ? pa - pb : a.dist - b.dist;
    });
    const best = candidates[0]!;
    return { point: best.point, kind: best.kind };
  }
}
