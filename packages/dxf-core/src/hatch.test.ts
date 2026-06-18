import { describe, it, expect } from 'vitest';
import { parseDxf } from './index.js';
import type { HatchEntity } from './types.js';

/** Serialize [code, value] group pairs into DXF text. */
function dxf(pairs: Array<[number, string | number]>): string {
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';
}

/** Wrap entity groups in a minimal ENTITIES-only DXF document. */
function entitiesDoc(entityPairs: Array<[number, string | number]>): string {
  return dxf([
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...entityPairs,
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);
}

/** A closed 10×10 polyline boundary path (group 92 = external + polyline). */
const SQUARE_BOUNDARY: Array<[number, string | number]> = [
  [91, 1],
  [92, 3],
  [72, 0],
  [73, 1],
  [93, 4],
  [10, 0],
  [20, 0],
  [10, 10],
  [20, 0],
  [10, 10],
  [20, 10],
  [10, 0],
  [20, 10],
  [97, 0],
];

describe('HATCH parsing', () => {
  it('recovers a solid-fill hatch dxf-parser would otherwise drop', () => {
    const doc = entitiesDoc([
      [0, 'HATCH'],
      [8, 'WALLS'],
      [62, 1],
      [100, 'AcDbHatch'],
      [2, 'SOLID'],
      [70, 1],
      [71, 0],
      ...SQUARE_BOUNDARY,
      [75, 0],
      [76, 1],
      [98, 1],
      [10, 5],
      [20, 5],
    ]);
    const scene = parseDxf(doc);
    const hatches = scene.entities.filter((e): e is HatchEntity => e.type === 'hatch');
    expect(hatches).toHaveLength(1);
    const h = hatches[0]!;
    expect(h.solid).toBe(true);
    expect(h.layer).toBe('WALLS');
    expect(h.color).toEqual({ r: 255, g: 0, b: 0 });
    expect(h.loops).toHaveLength(1);
    const loop = h.loops[0]!;
    expect(loop.kind).toBe('polyline');
    if (loop.kind === 'polyline') {
      expect(loop.vertices).toHaveLength(4);
      expect(loop.closed).toBe(true);
    }
    // No warning about an unsupported HATCH.
    expect(scene.warnings.join(' ')).not.toMatch(/HATCH/i);
  });

  it('recovers a pattern hatch with its definition lines', () => {
    const doc = entitiesDoc([
      [0, 'HATCH'],
      [8, '0'],
      [100, 'AcDbHatch'],
      [2, 'ANSI31'],
      [70, 0],
      [71, 0],
      ...SQUARE_BOUNDARY,
      [75, 0],
      [76, 1],
      [52, 0],
      [41, 1],
      [77, 0],
      [78, 1],
      [53, 45], // 45° pattern line
      [43, 0],
      [44, 0],
      [45, 0],
      [46, 0.5], // perpendicular spacing
      [79, 0],
      [98, 1],
      [10, 5],
      [20, 5],
    ]);
    const scene = parseDxf(doc);
    const h = scene.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(h.solid).toBe(false);
    expect(h.pattern).toHaveLength(1);
    const line = h.pattern[0]!;
    expect(line.angle).toBeCloseTo(Math.PI / 4, 6); // 45° → radians
    expect(line.spacing).toBeCloseTo(0.5, 6);
  });

  it('parses a line/arc edge boundary', () => {
    const doc = entitiesDoc([
      [0, 'HATCH'],
      [8, '0'],
      [100, 'AcDbHatch'],
      [2, 'SOLID'],
      [70, 1],
      [71, 0],
      [91, 1],
      [92, 1], // external, edge-based (not polyline)
      [93, 2], // two edges
      [72, 1], // line edge
      [10, 0],
      [20, 0],
      [11, 10],
      [21, 0],
      [72, 2], // arc edge
      [10, 5],
      [20, 0],
      [40, 5],
      [50, 0],
      [51, 180],
      [73, 1],
      [97, 0],
      [98, 1],
      [10, 5],
      [20, 2],
    ]);
    const scene = parseDxf(doc);
    const h = scene.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(h.loops).toHaveLength(1);
    const loop = h.loops[0]!;
    expect(loop.kind).toBe('edges');
    if (loop.kind === 'edges') {
      expect(loop.edges.map((e) => e.type)).toEqual(['line', 'arc']);
    }
  });
});
