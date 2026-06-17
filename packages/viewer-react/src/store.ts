import { create } from 'zustand';
import type { DrawingUnits, RGB, Scene, Vec2 } from '@dwg-viewer/dxf-core';
import type { Measurement, MeasureTool, SnapResult } from '@dwg-viewer/measure';

export interface LayerView {
  name: string;
  color: RGB;
  visible: boolean;
  frozen: boolean;
}

export type ViewerStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Minimum points a tool needs before a measurement can be committed. */
const MIN_POINTS: Record<MeasureTool, number> = { distance: 2, area: 3, angle: 3 };

function samePoint(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

interface ViewerState {
  status: ViewerStatus;
  fileName: string | null;
  units: DrawingUnits | null;
  layers: LayerView[];
  warnings: string[];
  entityCount: number;
  error: string | null;
  /** Whether per-entity lineweights are rendered (AutoCAD's LWDISPLAY). */
  lineweightDisplay: boolean;
  /** World-space cursor position (true coords), updated on pointer move. */
  cursor: Vec2 | null;

  /** Active measurement tool, or null when panning/navigating. */
  tool: MeasureTool | null;
  /** Points placed for the in-progress measurement (true world coords). */
  draftPoints: Vec2[];
  /** Snapped world cursor while a tool is active (drives the rubber-band preview). */
  hover: Vec2 | null;
  /** Current object snap under the cursor (drives the snap marker). */
  snap: SnapResult | null;
  /** Completed measurements. */
  measurements: Measurement[];

  beginLoad: (fileName: string) => void;
  setScene: (scene: Scene) => void;
  failLoad: (message: string) => void;
  toggleLayer: (name: string) => void;
  showAllLayers: () => void;
  setLineweightDisplay: (enabled: boolean) => void;
  setCursor: (cursor: Vec2 | null) => void;

  setTool: (tool: MeasureTool | null) => void;
  setHover: (hover: Vec2 | null, snap: SnapResult | null) => void;
  addDraftPoint: (point: Vec2) => void;
  finishDraft: () => void;
  cancelDraft: () => void;
  clearMeasurements: () => void;
}

let nextMeasurementId = 1;

export const useViewerStore = create<ViewerState>((set) => ({
  status: 'idle',
  fileName: null,
  units: null,
  layers: [],
  warnings: [],
  entityCount: 0,
  error: null,
  lineweightDisplay: true,
  cursor: null,

  tool: null,
  draftPoints: [],
  hover: null,
  snap: null,
  measurements: [],

  beginLoad: (fileName) =>
    set({
      status: 'loading',
      fileName,
      error: null,
      warnings: [],
      cursor: null,
      draftPoints: [],
      hover: null,
      snap: null,
      measurements: [],
    }),

  setScene: (scene) =>
    set({
      status: 'ready',
      units: scene.units,
      warnings: scene.warnings,
      entityCount: scene.entityCount,
      layers: scene.layers
        .map((l) => ({
          name: l.name,
          color: l.color,
          visible: l.visible && !l.frozen,
          frozen: l.frozen,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),

  failLoad: (message) => set({ status: 'error', error: message }),

  toggleLayer: (name) =>
    set((state) => ({
      layers: state.layers.map((l) => (l.name === name ? { ...l, visible: !l.visible } : l)),
    })),

  showAllLayers: () =>
    set((state) => ({
      layers: state.layers.map((l) => (l.visible ? l : { ...l, visible: true })),
    })),

  setLineweightDisplay: (enabled) => set({ lineweightDisplay: enabled }),

  setCursor: (cursor) => set({ cursor }),

  setTool: (tool) =>
    set((state) => ({
      // Toggle the active tool off when re-selected; always reset the draft.
      tool: state.tool === tool ? null : tool,
      draftPoints: [],
      hover: null,
      snap: null,
    })),

  setHover: (hover, snap) => set({ hover, snap }),

  addDraftPoint: (point) =>
    set((state) => {
      if (!state.tool) return {};
      const last = state.draftPoints[state.draftPoints.length - 1];
      if (last && samePoint(last, point)) return {}; // ignore duplicate (e.g. double-click)
      const points = [...state.draftPoints, point];
      // Angle is exactly three points — commit automatically on the third.
      if (state.tool === 'angle' && points.length === MIN_POINTS.angle) {
        return {
          measurements: [
            ...state.measurements,
            { id: nextMeasurementId++, tool: 'angle', points },
          ],
          draftPoints: [],
        };
      }
      return { draftPoints: points };
    }),

  finishDraft: () =>
    set((state) => {
      if (!state.tool) return {};
      const min = MIN_POINTS[state.tool];
      if (state.draftPoints.length < min) return { draftPoints: [] };
      return {
        measurements: [
          ...state.measurements,
          { id: nextMeasurementId++, tool: state.tool, points: state.draftPoints },
        ],
        draftPoints: [],
      };
    }),

  cancelDraft: () => set({ draftPoints: [], hover: null, snap: null }),

  clearMeasurements: () => set({ measurements: [], draftPoints: [], hover: null, snap: null }),
}));
