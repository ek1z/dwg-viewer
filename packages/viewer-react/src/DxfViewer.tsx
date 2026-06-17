import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { parseDxf } from '@dwg-viewer/dxf-core';
import { isDwgFile, parseDwg } from '@dwg-viewer/dwg-core';
import { ViewerEngine } from '@dwg-viewer/viewer-engine';
import { useViewerStore } from './store.js';
import { LayerPanel } from './LayerPanel.js';
import { Toolbar } from './Toolbar.js';
import { MeasureOverlay } from './MeasureOverlay.js';
import { toolHint } from './measureLabel.js';
import './styles.css';

export interface DxfViewerProps {
  /** Background color for the canvas (hex). */
  background?: number;
  /**
   * URL of the TrueType/OpenType/WOFF font used to substitute SHX for TEXT/MTEXT.
   * Defaults to the bundled Liberation Sans served from the app's `public/` dir,
   * so no font is fetched from a CDN and rendering stays on-device.
   */
  fontUrl?: string;
}

/** Screen-space snap tolerance (CSS pixels) — kept constant on screen via zoom. */
const SNAP_PIXELS = 12;

/** Self-hosted substitution font shipped in `apps/web/public/fonts`. */
const DEFAULT_FONT_URL = '/fonts/LiberationSans-Regular.ttf';

export function DxfViewer({
  background,
  fontUrl = DEFAULT_FONT_URL,
}: DxfViewerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** Bumped on every engine camera change so the SVG overlay re-projects. */
  const [frame, setFrame] = useState(0);

  const beginLoad = useViewerStore((s) => s.beginLoad);
  const setScene = useViewerStore((s) => s.setScene);
  const failLoad = useViewerStore((s) => s.failLoad);
  const status = useViewerStore((s) => s.status);
  const tool = useViewerStore((s) => s.tool);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new ViewerEngine(canvas, {
      ...(background !== undefined ? { background } : {}),
      fontUrl,
    });
    engineRef.current = engine;

    const container = canvas.parentElement;
    const ro = new ResizeObserver(() => engine.resize());
    if (container) ro.observe(container);

    const offChange = engine.onChange(() => setFrame((f) => f + 1));

    const snapAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const raw = engine.screenToWorld(clientX - rect.left, clientY - rect.top);
      const snap = engine.querySnap(raw, SNAP_PIXELS);
      return { world: snap ? snap.point : raw, snap };
    };

    const onMove = (ev: PointerEvent) => {
      const store = useViewerStore.getState();
      if (store.tool) {
        const { world, snap } = snapAt(ev.clientX, ev.clientY);
        store.setHover(world, snap);
        store.setCursor(world);
      } else {
        const rect = canvas.getBoundingClientRect();
        store.setCursor(engine.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top));
      }
    };
    const onLeave = () => {
      const store = useViewerStore.getState();
      store.setCursor(null);
      store.setHover(null, null);
    };
    const onClick = (ev: MouseEvent) => {
      const store = useViewerStore.getState();
      if (!store.tool || ev.button !== 0) return;
      store.addDraftPoint(snapAt(ev.clientX, ev.clientY).world);
    };
    const onDblClick = (ev: MouseEvent) => {
      const store = useViewerStore.getState();
      if (!store.tool) return;
      ev.preventDefault();
      store.finishDraft();
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('dblclick', onDblClick);

    return () => {
      ro.disconnect();
      offChange();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDblClick);
      engine.dispose();
      engineRef.current = null;
    };
  }, [background, fontUrl]);

  // Reserve the left button for point placement while a measure tool is active.
  useEffect(() => {
    engineRef.current?.setPanWithLeftButton(tool === null);
  }, [tool]);

  // Enter finishes the in-progress measurement; Escape cancels it.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const store = useViewerStore.getState();
      if (!store.tool) return;
      if (ev.key === 'Enter') store.finishDraft();
      else if (ev.key === 'Escape') store.cancelDraft();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      const engine = engineRef.current;
      if (!engine) return;
      beginLoad(file.name);
      try {
        // DWG is converted to DXF in the browser; both end up as the same Scene.
        const scene = isDwgFile(file.name)
          ? await parseDwg(await file.arrayBuffer())
          : parseDxf(await file.text());
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
          className={`dxf-viewer__stage${dragOver ? ' dxf-viewer__stage--dragover' : ''}${
            tool ? ' dxf-viewer__stage--measuring' : ''
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <canvas ref={canvasRef} className="dxf-viewer__canvas" />
          <MeasureOverlay engineRef={engineRef} frame={frame} />
          {status === 'idle' && (
            <div className="dxf-viewer__hint">Open or drop a .dxf or .dwg file to begin</div>
          )}
          {status === 'loading' && <div className="dxf-viewer__hint">Parsing…</div>}
          {status === 'ready' && tool && (
            <div className="dxf-viewer__measure-hint">{toolHint(tool)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
