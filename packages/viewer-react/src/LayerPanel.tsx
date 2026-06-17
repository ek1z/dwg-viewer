import type { ReactElement } from 'react';
import { useViewerStore } from './store.js';
import type { RGB } from '@dwg-viewer/dxf-core';

export interface LayerPanelProps {
  onSetLayerVisible: (name: string, visible: boolean) => void;
}

function swatch(color: RGB): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function LayerPanel({ onSetLayerVisible }: LayerPanelProps): ReactElement | null {
  const layers = useViewerStore((s) => s.layers);
  const toggleLayer = useViewerStore((s) => s.toggleLayer);
  const warnings = useViewerStore((s) => s.warnings);

  if (layers.length === 0) return null;

  return (
    <aside className="dxf-layers">
      <div className="dxf-layers__header">Layers ({layers.length})</div>
      <ul className="dxf-layers__list">
        {layers.map((layer) => (
          <li key={layer.name} className="dxf-layers__item">
            <label className="dxf-layers__label" title={layer.name}>
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={() => {
                  toggleLayer(layer.name);
                  onSetLayerVisible(layer.name, !layer.visible);
                }}
              />
              <span className="dxf-layers__swatch" style={{ background: swatch(layer.color) }} />
              <span className="dxf-layers__name">{layer.name}</span>
              {layer.frozen && <span className="dxf-layers__badge">frozen</span>}
            </label>
          </li>
        ))}
      </ul>
      {warnings.length > 0 && (
        <details className="dxf-layers__warnings">
          <summary>{warnings.length} warning(s)</summary>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}
