import DxfParser from 'dxf-parser';
import { buildScene } from './adapter.js';
import { scanLayerDefaults } from './layerDefaults.js';
import type { Scene } from './types.js';

export * from './types.js';
export {
  IDENTITY,
  multiply,
  apply,
  translation,
  scaling,
  rotation,
  isReflecting,
  decompose,
} from './matrix.js';
export type { Decomposed } from './matrix.js';
export { aciToRGB, unpackRGB, resolveColor } from './color.js';
export { resolveUnits } from './units.js';
export { buildScene } from './adapter.js';
export { scanLayerDefaults } from './layerDefaults.js';
export type { LayerDefault } from './layerDefaults.js';

/**
 * Parse a DXF document (as text) into a normalized scene model.
 *
 * @throws if the input cannot be parsed as DXF.
 */
export function parseDxf(text: string): Scene {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  if (!dxf) throw new Error('Failed to parse DXF: parser returned null.');
  // Recover per-layer linetype/lineweight defaults that dxf-parser discards.
  return buildScene(dxf, scanLayerDefaults(text));
}
