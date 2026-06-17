import type { ReactElement, RefObject } from 'react';
import type { DrawingUnits, Vec2 } from '@dwg-viewer/dxf-core';
import type { Measurement, MeasureTool, SnapKind, SnapResult } from '@dwg-viewer/measure';
import { centroid } from '@dwg-viewer/measure';
import type { ViewerEngine } from '@dwg-viewer/viewer-engine';
import { useViewerStore } from './store.js';
import { measurementValue } from './measureLabel.js';

export interface MeasureOverlayProps {
  engineRef: RefObject<ViewerEngine | null>;
  /** Bumped on every camera change so projected positions refresh. */
  frame: number;
}

type Project = (world: Vec2) => Vec2;

/**
 * SVG annotation layer drawn above the WebGL canvas (plan §4). Measurements are
 * stored in true world coordinates; they are projected to screen pixels on each
 * render — re-run whenever the camera changes (`frame`) — so annotations track
 * the drawing under pan/zoom. The layer never captures pointer events.
 */
export function MeasureOverlay({ engineRef, frame }: MeasureOverlayProps): ReactElement | null {
  const tool = useViewerStore((s) => s.tool);
  const draftPoints = useViewerStore((s) => s.draftPoints);
  const hover = useViewerStore((s) => s.hover);
  const snap = useViewerStore((s) => s.snap);
  const measurements = useViewerStore((s) => s.measurements);
  const units = useViewerStore((s) => s.units);

  const engine = engineRef.current;
  if (!engine) return null;
  const project: Project = (w) => engine.worldToScreen(w);

  return (
    <svg className="dxf-measure" data-frame={frame}>
      {measurements.map((m) => (
        <MeasurementShape key={m.id} measurement={m} units={units} project={project} />
      ))}
      {tool && draftPoints.length > 0 && (
        <DraftShape tool={tool} points={draftPoints} hover={hover} units={units} project={project} />
      )}
      {snap && <SnapMarker snap={snap} project={project} />}
    </svg>
  );
}

function MeasurementShape({
  measurement,
  units,
  project,
}: {
  measurement: Measurement;
  units: DrawingUnits | null;
  project: Project;
}): ReactElement {
  return renderMeasure(measurement.tool, measurement.points, null, units, project);
}

function DraftShape({
  tool,
  points,
  hover,
  units,
  project,
}: {
  tool: MeasureTool;
  points: ReadonlyArray<Vec2>;
  hover: Vec2 | null;
  units: DrawingUnits | null;
  project: Project;
}): ReactElement {
  return renderMeasure(tool, points, hover, units, project);
}

function key(prefix: string, i: number): string {
  return `${prefix}-${i}`;
}

function line(a: Vec2, b: Vec2, k: string, preview = false): ReactElement {
  return (
    <line
      key={k}
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      className={preview ? 'dxf-measure__line dxf-measure__line--preview' : 'dxf-measure__line'}
    />
  );
}

function vertex(p: Vec2, k: string): ReactElement {
  return <circle key={k} cx={p.x} cy={p.y} r={3} className="dxf-measure__vertex" />;
}

function label(anchor: Vec2, text: string, k: string): ReactElement | null {
  if (!text) return null;
  return (
    <text key={k} x={anchor.x + 8} y={anchor.y - 8} className="dxf-measure__label">
      {text}
    </text>
  );
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Render one measurement — completed (hover null) or in-progress (hover is the
 * live snapped cursor, drawn as a dashed rubber band). Distance and area share
 * a polyline body; angle draws two rays and the included angle.
 */
function renderMeasure(
  tool: MeasureTool,
  worldPoints: ReadonlyArray<Vec2>,
  hover: Vec2 | null,
  units: DrawingUnits | null,
  project: Project,
): ReactElement {
  const screen = worldPoints.map(project);
  const previewScreen = hover ? project(hover) : null;
  const effective = hover ? [...worldPoints, hover] : worldPoints;
  const text = measurementValue(tool, effective, units);
  const elems: Array<ReactElement | null> = [];

  if (tool === 'angle') {
    const vtx = screen[1] ?? screen[0];
    if (screen.length >= 2) elems.push(line(screen[0]!, screen[1]!, 'a0'));
    if (screen.length >= 3) elems.push(line(screen[1]!, screen[2]!, 'a1'));
    if (previewScreen) {
      const from = screen.length === 1 ? screen[0]! : screen.length === 2 ? screen[1]! : null;
      if (from) elems.push(line(from, previewScreen, 'ap', true));
    }
    screen.forEach((p, i) => elems.push(vertex(p, key('av', i))));
    if (vtx) elems.push(label(vtx, text, 'al'));
    return <g>{elems}</g>;
  }

  // distance & area: solid edges between placed points
  for (let i = 0; i < screen.length - 1; i++) {
    elems.push(line(screen[i]!, screen[i + 1]!, key('s', i)));
  }

  if (tool === 'area') {
    if (hover === null && screen.length >= 3) {
      // completed polygon: close the ring and fill it
      elems.push(line(screen[screen.length - 1]!, screen[0]!, 'close'));
      elems.unshift(
        <polygon
          key="fill"
          points={screen.map((p) => `${p.x},${p.y}`).join(' ')}
          className="dxf-measure__fill"
        />,
      );
    }
    if (previewScreen && screen.length >= 1) {
      elems.push(line(screen[screen.length - 1]!, previewScreen, 'pv', true));
      if (screen.length >= 2) elems.push(line(previewScreen, screen[0]!, 'pc', true));
    }
  } else if (previewScreen && screen.length >= 1) {
    // distance preview segment
    elems.push(line(screen[screen.length - 1]!, previewScreen, 'pv', true));
  }

  screen.forEach((p, i) => elems.push(vertex(p, key('v', i))));

  const anchor =
    tool === 'area'
      ? centroid(effective.map(project))
      : previewScreen
        ? midpoint(screen[screen.length - 1]!, previewScreen)
        : screen.length >= 2
          ? midpoint(screen[screen.length - 2]!, screen[screen.length - 1]!)
          : screen[0];
  if (anchor) elems.push(label(anchor, text, 'l'));

  return <g>{elems}</g>;
}

const SNAP_LABELS: Record<SnapKind, string> = {
  endpoint: 'end',
  midpoint: 'mid',
  center: 'center',
  intersection: 'intersect',
  nearest: 'near',
};

function SnapMarker({ snap, project }: { snap: SnapResult; project: Project }): ReactElement {
  const p = project(snap.point);
  const s = 5;
  let shape: ReactElement;
  switch (snap.kind) {
    case 'endpoint':
      shape = (
        <rect x={p.x - s} y={p.y - s} width={s * 2} height={s * 2} className="dxf-measure__snap" />
      );
      break;
    case 'midpoint':
      shape = (
        <polygon
          points={`${p.x},${p.y - s} ${p.x + s},${p.y + s} ${p.x - s},${p.y + s}`}
          className="dxf-measure__snap"
        />
      );
      break;
    case 'center':
      shape = <circle cx={p.x} cy={p.y} r={s} className="dxf-measure__snap" />;
      break;
    case 'intersection':
      shape = (
        <g className="dxf-measure__snap">
          <line x1={p.x - s} y1={p.y - s} x2={p.x + s} y2={p.y + s} />
          <line x1={p.x - s} y1={p.y + s} x2={p.x + s} y2={p.y - s} />
        </g>
      );
      break;
    default:
      shape = (
        <g className="dxf-measure__snap">
          <line x1={p.x - s} y1={p.y} x2={p.x + s} y2={p.y} />
          <line x1={p.x} y1={p.y - s} x2={p.x} y2={p.y + s} />
        </g>
      );
  }
  return (
    <g>
      {shape}
      <text x={p.x + s + 4} y={p.y - s} className="dxf-measure__snap-label">
        {SNAP_LABELS[snap.kind]}
      </text>
    </g>
  );
}
