import type { ReactElement, RefObject } from 'react';
import type { Vec2 } from '@dwg-viewer/dxf-core';
import type { ViewerEngine } from '@dwg-viewer/viewer-engine';
import { useViewerStore } from './store.js';

export interface PrintRegionOverlayProps {
  engineRef: RefObject<ViewerEngine | null>;
  /** Bumped on every camera change so the rectangle re-projects. */
  frame: number;
}

/**
 * SVG layer (above the canvas, like the measurement overlay) that draws the
 * print-region rubber band: a dashed rectangle while drawing toward the cursor,
 * a solid rectangle once committed. Region corners are stored in true world
 * coordinates and projected to screen pixels on every camera change (`frame`).
 */
export function PrintRegionOverlay({
  engineRef,
  frame,
}: PrintRegionOverlayProps): ReactElement | null {
  const printMode = useViewerStore((s) => s.printMode);
  const corners = useViewerStore((s) => s.printCorners);
  const hover = useViewerStore((s) => s.printHover);
  const region = useViewerStore((s) => s.printRegion);

  const engine = engineRef.current;
  if (!engine || (!printMode && !region)) return null;
  const project = (w: Vec2): Vec2 => engine.worldToScreen(w);

  const first = corners[0];
  const draft =
    printMode && first && hover && !region
      ? rect(project(first), project(hover), 'dxf-print__rect dxf-print__rect--preview')
      : null;
  const committed = region
    ? rect(project(region.min), project(region.max), 'dxf-print__rect')
    : null;

  return (
    <svg className="dxf-measure" data-frame={frame}>
      {draft}
      {committed}
    </svg>
  );
}

function rect(a: Vec2, b: Vec2, className: string): ReactElement {
  return (
    <rect
      x={Math.min(a.x, b.x)}
      y={Math.min(a.y, b.y)}
      width={Math.abs(a.x - b.x)}
      height={Math.abs(a.y - b.y)}
      className={className}
    />
  );
}
