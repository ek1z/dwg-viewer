import { useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import type { ViewerEngine } from '@dwg-viewer/viewer-engine';
import { useViewerStore } from './store.js';
import { PAPER_SIZES, computePrintScale, openPrintDialog } from './printRegion.js';

/** Printable margin (mm) and capture resolution shared by every print. */
const MARGIN_MM = 10;
const CAPTURE_MAX_PX = 2400;

const FIRST_PAPER = PAPER_SIZES[0]!;

export interface PrintPanelProps {
  engineRef: RefObject<ViewerEngine | null>;
}

/**
 * Settings panel shown once a print region is committed. Orientation follows the
 * region's aspect; the scale label is informational (output is fit-to-page).
 * "Print / Save as PDF" rasterizes the region and opens the browser print
 * dialog, where "Save as PDF" is the standard destination.
 */
export function PrintPanel({ engineRef }: PrintPanelProps): ReactElement | null {
  const region = useViewerStore((s) => s.printRegion);
  const units = useViewerStore((s) => s.units);
  const fileName = useViewerStore((s) => s.fileName);
  const clearPrintRegion = useViewerStore((s) => s.clearPrintRegion);
  const [paperId, setPaperId] = useState(FIRST_PAPER.id);
  const [whiteBg, setWhiteBg] = useState(true);

  if (!region) return null;

  const worldW = region.max.x - region.min.x;
  const worldH = region.max.y - region.min.y;
  const orientation: 'portrait' | 'landscape' = worldW >= worldH ? 'landscape' : 'portrait';
  const paper = PAPER_SIZES.find((p) => p.id === paperId) ?? FIRST_PAPER;
  const pageWmm = orientation === 'landscape' ? paper.heightMm : paper.widthMm;
  const pageHmm = orientation === 'landscape' ? paper.widthMm : paper.heightMm;
  const scaleLabel = computePrintScale(units, worldW, worldH, pageWmm, pageHmm, MARGIN_MM);

  const onPrint = (): void => {
    const engine = engineRef.current;
    if (!engine) return;
    const dataUrl = engine.captureRegion(region.min, region.max, {
      maxPx: CAPTURE_MAX_PX,
      background: whiteBg ? 0xffffff : 0x1e1e1e,
    });
    openPrintDialog(dataUrl, {
      pageWmm,
      pageHmm,
      marginMm: MARGIN_MM,
      title: fileName ?? 'Drawing',
      scaleLabel,
    });
  };

  return (
    <div className="dxf-print-panel">
      <div className="dxf-print-panel__title">Print region</div>
      <label className="dxf-print-panel__row">
        <span>Paper</span>
        <select value={paperId} onChange={(e) => setPaperId(e.target.value)}>
          {PAPER_SIZES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <div className="dxf-print-panel__row">
        <span>Orientation</span>
        <span className="dxf-print-panel__value">{orientation}</span>
      </div>
      <div className="dxf-print-panel__row">
        <span>Scale</span>
        <span className="dxf-print-panel__value">{scaleLabel ?? 'unitless'}</span>
      </div>
      <label className="dxf-print-panel__row dxf-print-panel__row--check">
        <input type="checkbox" checked={whiteBg} onChange={(e) => setWhiteBg(e.target.checked)} />
        <span>White background</span>
      </label>
      <div className="dxf-print-panel__actions">
        <button
          type="button"
          className="dxf-toolbar__btn dxf-toolbar__btn--active"
          onClick={onPrint}
        >
          Print / Save as PDF
        </button>
        <button type="button" className="dxf-toolbar__btn" onClick={clearPrintRegion}>
          Cancel
        </button>
      </div>
    </div>
  );
}
