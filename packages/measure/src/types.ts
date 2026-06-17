import type { Vec2 } from '@dwg-viewer/dxf-core';

/**
 * Object-snap categories, in the order they take precedence when several
 * candidates fall within the snap tolerance (see {@link SNAP_PRIORITY}).
 */
export type SnapKind = 'endpoint' | 'intersection' | 'midpoint' | 'center' | 'nearest';

export interface SnapResult {
  /** Snapped world-space point (true float64 coordinates). */
  point: Vec2;
  kind: SnapKind;
}

/** Lower number = higher precedence when ranking snap candidates. */
export const SNAP_PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  intersection: 1,
  midpoint: 2,
  center: 3,
  nearest: 4,
};

/** The interactive measurement tools. */
export type MeasureTool = 'distance' | 'area' | 'angle';

export interface Measurement {
  id: number;
  tool: MeasureTool;
  /** World-space points (true float64), in click order. */
  points: Vec2[];
}
