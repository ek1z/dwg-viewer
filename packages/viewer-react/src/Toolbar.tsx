import { useRef } from 'react';
import type { ReactElement } from 'react';
import { useViewerStore } from './store.js';

export interface ToolbarProps {
  onOpenFile: (file: File) => void | Promise<void>;
  onFit: () => void;
}

function formatCoord(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export function Toolbar({ onOpenFile, onFit }: ToolbarProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const fileName = useViewerStore((s) => s.fileName);
  const units = useViewerStore((s) => s.units);
  const entityCount = useViewerStore((s) => s.entityCount);
  const cursor = useViewerStore((s) => s.cursor);
  const status = useViewerStore((s) => s.status);

  return (
    <div className="dxf-toolbar">
      <button
        type="button"
        className="dxf-toolbar__btn"
        onClick={() => inputRef.current?.click()}
      >
        Open DXF
      </button>
      <button
        type="button"
        className="dxf-toolbar__btn"
        onClick={onFit}
        disabled={status !== 'ready'}
      >
        Fit
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".dxf,application/dxf,image/vnd.dxf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onOpenFile(file);
          e.target.value = '';
        }}
      />
      <div className="dxf-toolbar__spacer" />
      {fileName && <span className="dxf-toolbar__meta">{fileName}</span>}
      {status === 'ready' && (
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
