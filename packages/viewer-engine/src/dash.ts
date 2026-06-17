import type { Vec2 } from '@dwg-viewer/dxf-core';

/**
 * Break a polyline into dash sub-polylines following a DXF linetype pattern.
 *
 * DXF linetypes can be multi-element (e.g. DASHDOT = dash, gap, dot, gap), which
 * three.js `LineMaterial` dashing — a single dash/gap pair — cannot represent.
 * So we expand dashes on the CPU into ordinary segments that reuse the existing
 * fat-line batching and instancing untouched.
 *
 * The pattern values are dash/gap lengths in *world units*: positive = pen down
 * (dash), negative = pen up (gap), 0 = dot. They are multiplied by `scale`
 * (global `$LTSCALE` × the entity's linetype scale). The walk is continuous
 * across vertices, so the pattern flows around corners the way CAD draws it.
 *
 * Returns an array of pen-down polylines (each ≥ 2 points; dots become a tiny
 * 2-point dash so they remain visible). A continuous/empty pattern, a
 * non-positive scale, or a degenerate path yields the input unchanged as a
 * single run.
 */
export function expandDashed(
  points: ReadonlyArray<Vec2>,
  pattern: ReadonlyArray<number>,
  scale: number,
  closed: boolean,
): Vec2[][] {
  if (points.length < 2) return points.length ? [points.slice()] : [];

  const elems = pattern.map((p) => p * scale);
  const period = elems.reduce((s, v) => s + Math.abs(v), 0);
  // Nothing to dash, or a pattern that is all "pen down": draw solid.
  if (!Number.isFinite(period) || period <= 0 || !elems.some((v) => v < 0 || v === 0)) {
    return [closed ? [...points, points[0]!] : points.slice()];
  }

  // Walk the path, advancing through the pattern; emit dashes for pen-down runs.
  const path = closed ? [...points, points[0]!] : points;
  const totalLen = pathLength(path);
  // A minimal dot/dash length so dots and zero-length runs stay visible.
  const dotLen = Math.max(period * 1e-3, totalLen * 1e-4);

  // Guard against pathological blow-up (a tiny pattern on a very long path):
  // if a path would emit more than this many dashes, fall back to solid.
  const MAX_DASHES = 5000;
  if (totalLen / period > MAX_DASHES) {
    return [closed ? [...points, points[0]!] : points.slice()];
  }

  const runs: Vec2[][] = [];
  let elemIdx = 0;
  let elemRemain = lenOf(elems[0]!, dotLen);
  let penDown = elems[0]! >= 0;
  let current: Vec2[] | null = penDown ? [path[0]!] : null;

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    const dx = (b.x - a.x) / segLen;
    const dy = (b.y - a.y) / segLen;
    let px = a.x;
    let py = a.y;

    while (segLen > elemRemain + 1e-12) {
      // Consume the rest of the current pattern element within this segment.
      px += dx * elemRemain;
      py += dy * elemRemain;
      segLen -= elemRemain;
      if (penDown && current) {
        current.push({ x: px, y: py });
        if (current.length >= 2) runs.push(current);
      }
      // Advance to the next pattern element.
      elemIdx = (elemIdx + 1) % elems.length;
      penDown = elems[elemIdx]! >= 0;
      elemRemain = lenOf(elems[elemIdx]!, dotLen);
      current = penDown ? [{ x: px, y: py }] : null;
    }

    // Remainder of this element falls beyond the segment end.
    elemRemain -= segLen;
    if (penDown && current) current.push({ x: b.x, y: b.y });
  }

  if (penDown && current && current.length >= 2) runs.push(current);
  return runs;
}

function lenOf(elem: number, dotLen: number): number {
  const a = Math.abs(elem);
  return a === 0 ? dotLen : a;
}

function pathLength(path: ReadonlyArray<Vec2>): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.y - path[i]!.y);
  }
  return total;
}
