import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDwgFile, parseDwg } from './index.js';

function fixture(name: string): ArrayBuffer {
  const path = fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('isDwgFile', () => {
  it('matches .dwg case-insensitively and rejects others', () => {
    expect(isDwgFile('plan.dwg')).toBe(true);
    expect(isDwgFile('PLAN.DWG')).toBe(true);
    expect(isDwgFile('plan.dxf')).toBe(false);
    expect(isDwgFile('dwg.txt')).toBe(false);
  });
});

describe('parseDwg', () => {
  // Real AutoCAD 2000 drawing converted end-to-end through the libredwg WASM
  // and the DXF scene pipeline.
  it('converts a DWG into a populated scene model', async () => {
    const scene = await parseDwg(fixture('sample_2000.dwg'));

    expect(scene.entities.length).toBeGreaterThan(0);
    // The fixture defines a non-default layer alongside layer "0".
    expect(scene.layers.map((l) => l.name)).toContain('Tavolo 1');
    // $INSUNITS = 4 (millimeters) in the source drawing.
    expect(scene.units.name).toBe('mm');
    expect(scene.bounds.valid).toBe(true);
  }, 30_000);

  it('rejects bytes that are not a DWG', async () => {
    const notDwg = new TextEncoder().encode('this is not a drawing').buffer;
    await expect(parseDwg(notDwg)).rejects.toThrow();
  }, 30_000);
});
