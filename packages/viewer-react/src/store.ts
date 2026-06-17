import { create } from 'zustand';
import type { DrawingUnits, RGB, Scene, Vec2 } from '@dwg-viewer/dxf-core';

export interface LayerView {
  name: string;
  color: RGB;
  visible: boolean;
  frozen: boolean;
}

export type ViewerStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ViewerState {
  status: ViewerStatus;
  fileName: string | null;
  units: DrawingUnits | null;
  layers: LayerView[];
  warnings: string[];
  entityCount: number;
  error: string | null;
  /** World-space cursor position (true coords), updated on pointer move. */
  cursor: Vec2 | null;

  beginLoad: (fileName: string) => void;
  setScene: (scene: Scene) => void;
  failLoad: (message: string) => void;
  toggleLayer: (name: string) => void;
  setCursor: (cursor: Vec2 | null) => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  status: 'idle',
  fileName: null,
  units: null,
  layers: [],
  warnings: [],
  entityCount: 0,
  error: null,
  cursor: null,

  beginLoad: (fileName) =>
    set({ status: 'loading', fileName, error: null, warnings: [], cursor: null }),

  setScene: (scene) =>
    set({
      status: 'ready',
      units: scene.units,
      warnings: scene.warnings,
      entityCount: scene.entities.length,
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

  setCursor: (cursor) => set({ cursor }),
}));
