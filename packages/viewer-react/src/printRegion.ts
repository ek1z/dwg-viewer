import type { DrawingUnits } from '@dwg-viewer/dxf-core';

/** A paper size in portrait orientation (millimetres). */
export interface PaperSize {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

export const PAPER_SIZES: ReadonlyArray<PaperSize> = [
  { id: 'a4', label: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a3', label: 'A3', widthMm: 297, heightMm: 420 },
  { id: 'letter', label: 'Letter', widthMm: 215.9, heightMm: 279.4 },
];

function formatRatio(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1);
}

/**
 * Approximate drawing scale ("≈ 1:100") for a region fitted (object-fit:
 * contain) onto a page's printable area. The binding dimension — the one that
 * reduces most under fit-to-page — sets the ratio. Returns null when the
 * drawing has no real-world units, since a scale would be meaningless.
 *
 * @param pageWmm / pageHmm oriented page size in mm (caller swaps for landscape)
 */
export function computePrintScale(
  units: DrawingUnits | null,
  worldW: number,
  worldH: number,
  pageWmm: number,
  pageHmm: number,
  marginMm: number,
): string | null {
  const mpu = units?.metersPerUnit;
  if (!mpu) return null;
  const worldWmm = worldW * mpu * 1000;
  const worldHmm = worldH * mpu * 1000;
  if (worldWmm <= 0 || worldHmm <= 0) return null;
  const printW = Math.max(pageWmm - 2 * marginMm, 1);
  const printH = Math.max(pageHmm - 2 * marginMm, 1);
  // n > 1 → drawing reduced (1:n); n < 1 → enlarged (m:1).
  const n = Math.max(worldWmm / printW, worldHmm / printH);
  return n >= 1 ? `≈ 1:${formatRatio(n)}` : `≈ ${formatRatio(1 / n)}:1`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

export interface PrintOptions {
  /** Oriented page size in mm. */
  pageWmm: number;
  pageHmm: number;
  marginMm: number;
  /** Caption parts shown beneath the image. */
  title: string;
  scaleLabel: string | null;
}

/**
 * Print a captured region image via a hidden iframe. The browser's print dialog
 * exposes "Save as PDF" as the destination, so this covers both print and PDF
 * export. The image is fitted to the page (object-fit: contain) at the chosen
 * paper size; a caption with the file name and scale is printed beneath it.
 */
export function openPrintDialog(dataUrl: string, opts: PrintOptions): void {
  const iframe = document.createElement('iframe');
  Object.assign(iframe.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
  });
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }

  const caption = [opts.title, opts.scaleLabel].filter(Boolean).join('  ·  ');
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    opts.title,
  )}</title><style>
    @page { size: ${opts.pageWmm}mm ${opts.pageHmm}mm; margin: ${opts.marginMm}mm; }
    html, body { margin: 0; padding: 0; height: 100%; }
    .sheet { box-sizing: border-box; margin: 0; height: 100vh; display: flex; flex-direction: column; }
    img { flex: 1 1 auto; min-height: 0; width: 100%; object-fit: contain; }
    figcaption { flex: 0 0 auto; padding-top: 6px; text-align: center; color: #333;
      font: 11px system-ui, -apple-system, sans-serif; }
  </style></head><body><figure class="sheet">
    <img src="${dataUrl}" alt="">
    ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}
  </figure></body></html>`);
  doc.close();

  const triggerPrint = (): void => {
    const win = iframe.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
    // The print dialog is modal; clean the iframe up once it returns.
    window.setTimeout(() => iframe.remove(), 1000);
  };

  // Wait for the (data-URL) image to decode so the first page isn't blank.
  const img = doc.querySelector('img');
  if (img && !img.complete) {
    img.addEventListener('load', triggerPrint, { once: true });
    img.addEventListener('error', triggerPrint, { once: true });
  } else {
    triggerPrint();
  }
}
