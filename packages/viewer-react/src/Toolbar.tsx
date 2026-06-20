import { useRef } from 'react';
import type { ReactElement } from 'react';
import type { MeasureTool } from '@dwg-viewer/measure';
import { useViewerStore } from './store.js';
import { measurementValue } from './measureLabel.js';

export interface ToolbarProps {
  onOpenFile: (file: File) => void | Promise<void>;
  onFit: () => void;
}

function formatCoord(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

const TOOLS: ReadonlyArray<{ tool: MeasureTool; label: string }> = [
  { tool: 'distance', label: 'Distance' },
  { tool: 'area', label: 'Area' },
  { tool: 'angle', label: 'Angle' },
];

export function Toolbar({ onOpenFile, onFit }: ToolbarProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileName = useViewerStore((s) => s.fileName);
  const units = useViewerStore((s) => s.units);
  const entityCount = useViewerStore((s) => s.entityCount);
  const cursor = useViewerStore((s) => s.cursor);
  const status = useViewerStore((s) => s.status);

  const tool = useViewerStore((s) => s.tool);
  const setTool = useViewerStore((s) => s.setTool);
  const draftPoints = useViewerStore((s) => s.draftPoints);
  const hover = useViewerStore((s) => s.hover);
  const measurements = useViewerStore((s) => s.measurements);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);
  const lineweightDisplay = useViewerStore((s) => s.lineweightDisplay);
  const setLineweightDisplay = useViewerStore((s) => s.setLineweightDisplay);
  const printMode = useViewerStore((s) => s.printMode);
  const setPrintMode = useViewerStore((s) => s.setPrintMode);

  const ready = status === 'ready';
  const liveValue =
    tool && draftPoints.length > 0
      ? measurementValue(tool, hover ? [...draftPoints, hover] : draftPoints, units)
      : '';

  return (
    <div className="dxf-toolbar">
      <button
        type="button"
        className="dxf-toolbar__btn"
        onClick={() => inputRef.current?.click()}
      >
        Open
      </button>
      <button
        type="button"
        className="dxf-toolbar__btn"
        onClick={onFit}
        disabled={!ready}
      >
        Fit
      </button>

      <span className="dxf-toolbar__divider" />
      {TOOLS.map(({ tool: t, label }) => (
        <button
          key={t}
          type="button"
          className={`dxf-toolbar__btn${tool === t ? ' dxf-toolbar__btn--active' : ''}`}
          onClick={() => setTool(t)}
          disabled={!ready}
          aria-pressed={tool === t}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        className="dxf-toolbar__btn"
        onClick={clearMeasurements}
        disabled={measurements.length === 0 && draftPoints.length === 0}
      >
        Clear
      </button>

      <span className="dxf-toolbar__divider" />
      <button
        type="button"
        className={`dxf-toolbar__btn${lineweightDisplay ? ' dxf-toolbar__btn--active' : ''}`}
        onClick={() => setLineweightDisplay(!lineweightDisplay)}
        disabled={!ready}
        aria-pressed={lineweightDisplay}
        title="Show lineweights"
      >
        Lineweights
      </button>
      <button
        type="button"
        className={`dxf-toolbar__btn${printMode ? ' dxf-toolbar__btn--active' : ''}`}
        onClick={() => setPrintMode(!printMode)}
        disabled={!ready}
        aria-pressed={printMode}
        title="Print or save a region as PDF"
      >
        Print
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".dxf,.dwg,application/dxf,image/vnd.dxf,image/vnd.dwg,application/acad"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onOpenFile(file);
          e.target.value = '';
        }}
      />
      <div className="dxf-toolbar__spacer" />
      {liveValue && <span className="dxf-toolbar__measure">{liveValue}</span>}
      {fileName && <span className="dxf-toolbar__meta">{fileName}</span>}
      {ready && (
        <span className="dxf-toolbar__meta">
          {entityCount.toLocaleString()} entities
          {units && units.name !== 'unitless' ? ` · ${units.name}` : ''}
        </span>
      )}
      {cursor && (
        <span className="dxf-toolbar__coords">
          {formatCoord(cursor.x)}, {formatCoord(cursor.y)}
        </span>
      )}
    </div>
  );
}
