import type { DrawingUnits, Vec2 } from '@dwg-viewer/dxf-core';
import {
  type MeasureTool,
  angleAt,
  distance,
  formatAngle,
  formatArea,
  formatLength,
  polygonArea,
  polygonPerimeter,
  polylineLength,
} from '@dwg-viewer/measure';

/**
 * Human-readable value for a measurement (completed or in-progress) given its
 * points in true world coordinates. Returns an empty string when there are not
 * yet enough points to be meaningful.
 */
export function measurementValue(
  tool: MeasureTool,
  points: ReadonlyArray<Vec2>,
  units: DrawingUnits | null,
): string {
  switch (tool) {
    case 'distance':
      if (points.length < 2) return '';
      return formatLength(polylineLength(points), units);
    case 'area':
      if (points.length === 2) return formatLength(distance(points[0]!, points[1]!), units);
      if (points.length < 3) return '';
      return `${formatArea(polygonArea(points), units)} · ${formatLength(
        polygonPerimeter(points),
        units,
      )}`;
    case 'angle':
      if (points.length < 3) return '';
      return formatAngle(angleAt(points[1]!, points[0]!, points[2]!));
  }
}

/** Short usage hint shown while a tool is active. */
export function toolHint(tool: MeasureTool): string {
  switch (tool) {
    case 'distance':
      return 'Click points to measure distance · double-click or Enter to finish · Esc to cancel · middle-drag to pan';
    case 'area':
      return 'Click ≥3 points to measure area · double-click or Enter to close · Esc to cancel · middle-drag to pan';
    case 'angle':
      return 'Click a point, the vertex, then a second point · Esc to cancel · middle-drag to pan';
  }
}
