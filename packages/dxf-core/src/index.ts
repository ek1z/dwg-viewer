import DxfParser from 'dxf-parser';
import { buildScene } from './adapter.js';
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
} from './matrix.js';
export { aciToRGB, unpackRGB, resolveColor } from './color.js';
export { resolveUnits } from './units.js';
export { buildScene } from './adapter.js';

/**
 * Parse a DXF document (as text) into a normalized scene model.
 *
 * @throws if the input cannot be parsed as DXF.
 */
export function parseDxf(text: string): Scene {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  if (!dxf) throw new Error('Failed to parse DXF: parser returned null.');
  return buildScene(dxf);
}
