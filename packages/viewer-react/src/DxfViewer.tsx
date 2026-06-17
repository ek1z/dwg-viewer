import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { parseDxf } from '@dwg-viewer/dxf-core';
import { ViewerEngine } from '@dwg-viewer/viewer-engine';
import { useViewerStore } from './store.js';
import { LayerPanel } from './LayerPanel.js';
import { Toolbar } from './Toolbar.js';
import './styles.css';

export interface DxfViewerProps {
  /** Background color for the canvas (hex). */
  background?: number;
}

export function DxfViewer({ background }: DxfViewerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const beginLoad = useViewerStore((s) => s.beginLoad);
  const setScene = useViewerStore((s) => s.setScene);
  const failLoad = useViewerStore((s) => s.failLoad);
  const setCursor = useViewerStore((s) => s.setCursor);
  const status = useViewerStore((s) => s.status);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new ViewerEngine(canvas, background !== undefined ? { background } : {});
    engineRef.current = engine;

    const container = canvas.parentElement;
    const ro = new ResizeObserver(() => engine.resize());
    if (container) ro.observe(container);

    const onMove = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      setCursor(engine.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top));
    };
    const onLeave = () => setCursor(null);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      engine.dispose();
      engineRef.current = null;
    };
  }, [background, setCursor]);

  const loadFile = useCallback(
    async (file: File) => {
      const engine = engineRef.current;
      if (!engine) return;
      beginLoad(file.name);
      try {
        const text = await file.text();
        const scene = parseDxf(text);
        engine.loadScene(scene);
        setScene(scene);
      } catch (err) {
        failLoad(err instanceof Error ? err.message : String(err));
      }
    },
    [beginLoad, setScene, failLoad],
  );

  const onFit = useCallback(() => engineRef.current?.fitToView(), []);
  const onSetLayerVisible = useCallback((name: string, visible: boolean) => {
    engineRef.current?.setLayerVisible(name, visible);
  }, []);

  const onDrop = useCallback(
    (ev: DragEvent) => {
      ev.preventDefault();
      setDragOver(false);
      const file = ev.dataTransfer.files?.[0];
      if (file) void loadFile(file);
    },
    [loadFile],
  );

  return (
    <div className="dxf-viewer">
      <Toolbar onOpenFile={loadFile} onFit={onFit} />
      <div className="dxf-viewer__body">
        <LayerPanel onSetLayerVisible={onSetLayerVisible} />
        <div
          className={`dxf-viewer__stage${dragOver ? ' dxf-viewer__stage--dragover' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <canvas ref={canvasRef} className="dxf-viewer__canvas" />
          {status === 'idle' && (
            <div className="dxf-viewer__hint">Open or drop a .dxf file to begin</div>
          )}
          {status === 'loading' && <div className="dxf-viewer__hint">Parsing…</div>}
        </div>
      </div>
    </div>
  );
}
