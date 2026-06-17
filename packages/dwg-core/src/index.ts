import type { LibreDwg } from '@mlightcad/libredwg-web';
import { parseDxf, type Scene } from '@dwg-viewer/dxf-core';

/** Resolved libredwg WASM instance (type erased; the import is dynamic). */
type LibreDwgInstance = Awaited<ReturnType<typeof LibreDwg.create>>;

/**
 * The WASM module is ~7 MB and self-initializes asynchronously, so we load it
 * once and share the instance across calls. The dynamic import also keeps it
 * out of the main bundle — DXF-only sessions never download it.
 */
let instancePromise: Promise<LibreDwgInstance> | null = null;

function getInstance(): Promise<LibreDwgInstance> {
  instancePromise ??= import('@mlightcad/libredwg-web').then(({ LibreDwg }) =>
    LibreDwg.create(),
  );
  return instancePromise;
}

/**
 * Parse a DWG drawing into the normalized scene model.
 *
 * DWG is converted to DXF text in-browser by the libredwg WASM, then handed to
 * the existing {@link parseDxf} pipeline — every downstream consumer (engine,
 * measurement, OCS/INSERT/unit handling) sees the same {@link Scene} it does
 * for native DXF, so nothing past this point needs to know the source format.
 *
 * @param data Raw DWG file bytes (e.g. from `File.arrayBuffer()`).
 * @throws if the WASM fails to load or the bytes are not a readable DWG.
 */
export async function parseDwg(data: ArrayBuffer): Promise<Scene> {
  const lib = await getInstance();
  const dxf = lib.dwg_write_dxf(data);
  if (!dxf) {
    throw new Error('Failed to read DWG: libredwg could not convert the file.');
  }
  return parseDxf(new TextDecoder().decode(dxf));
}

/** True when a filename looks like a DWG drawing (case-insensitive). */
export function isDwgFile(fileName: string): boolean {
  return /\.dwg$/i.test(fileName);
}
