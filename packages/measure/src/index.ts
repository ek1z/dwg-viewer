/**
 * Phase 2 measurement tools: object snapping (endpoint / midpoint / center /
 * intersection / nearest) backed by an R-tree spatial index, plus distance,
 * area and angle math and unit-aware formatting.
 *
 * Pure TypeScript with no framework or renderer dependency. All measurement
 * math runs on the float64 scene model — never on f32 GPU coordinates
 * (plan §2, §5) — so values stay exact at large survey coordinates.
 */

export type { SnapKind, SnapResult, MeasureTool, Measurement } from './types.js';
export { SNAP_PRIORITY } from './types.js';
export { SnapBuilder, SnapIndex } from './snap.js';
export {
  distance,
  polylineLength,
  polygonArea,
  polygonPerimeter,
  angleAt,
  closestPointOnSegment,
  segmentIntersection,
  centroid,
} from './geometry.js';
export { formatLength, formatArea, formatAngle } from './format.js';
