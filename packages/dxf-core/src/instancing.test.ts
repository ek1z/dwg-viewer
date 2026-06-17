import { describe, it, expect } from 'vitest';
import { parseDxf } from './index.js';
import { apply } from './matrix.js';
import type { InstanceEntity } from './types.js';

/**
 * Build a DXF with a block `SYM` (a single LINE from (0,0)→(1,0), base point at
 * the origin) plus `count` INSERTs of it. `extra` is injected verbatim into the
 * block body, and `inserts` lets a caller override the INSERT records (e.g. for a
 * MINSERT grid).
 */
function dxfWithBlock(opts: {
  count?: number;
  extra?: string;
  inserts?: string;
}): string {
  const { count = 0, extra = '', inserts } = opts;
  const insertRecords =
    inserts ??
    Array.from({ length: count }, (_, i) =>
      ['0', 'INSERT', '8', '0', '2', 'SYM', '10', String(i * 10), '20', '0', '30', '0'].join('\n'),
    ).join('\n');
  return [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', 'SYM', '70', '0', '10', '0', '20', '0', '30', '0', '3', 'SYM',
    '0', 'LINE', '8', '0', '10', '0.0', '20', '0.0', '11', '1.0', '21', '0.0',
    extra,
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    insertRecords,
    '0', 'ENDSEC',
    '0', 'EOF', '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const isInstance = (e: { type: string }): e is InstanceEntity => e.type === 'instance';

describe('block instancing', () => {
  it('instances a block repeated at or above the threshold', () => {
    const scene = parseDxf(dxfWithBlock({ count: 5 }));
    const instances = scene.entities.filter(isInstance);
    expect(instances).toHaveLength(5);
    // A single shared definition is built, not one per placement.
    expect(scene.blocks).toHaveLength(1);
    expect(scene.blocks[0]!.entities).toHaveLength(1);
    expect(scene.blocks[0]!.entities[0]!.type).toBe('polyline');
    // The block geometry is not also flattened into top-level entities.
    expect(scene.entities.some((e) => e.type === 'polyline')).toBe(false);
    // entityCount reflects expanded leaves (5 placements × 1 leaf each).
    expect(scene.entityCount).toBe(5);
  });

  it('flattens a block used fewer times than the threshold', () => {
    const scene = parseDxf(dxfWithBlock({ count: 3 }));
    expect(scene.entities.filter(isInstance)).toHaveLength(0);
    expect(scene.blocks).toHaveLength(0);
    expect(scene.entities.filter((e) => e.type === 'polyline')).toHaveLength(3);
    expect(scene.entityCount).toBe(3);
  });

  it('does not instance blocks containing text', () => {
    const text = ['0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '1', '1', 'HELLO'].join('\n');
    const scene = parseDxf(dxfWithBlock({ count: 5, extra: text }));
    expect(scene.entities.filter(isInstance)).toHaveLength(0);
    expect(scene.blocks).toHaveLength(0);
    // Falls back to flattening: 5 lines + 5 text entities.
    expect(scene.entities.filter((e) => e.type === 'polyline')).toHaveLength(5);
    expect(scene.entities.filter((e) => e.type === 'text')).toHaveLength(5);
  });

  it('bakes each placement transform into the instance', () => {
    const scene = parseDxf(dxfWithBlock({ count: 4 }));
    const instances = scene.entities.filter(isInstance);
    // The third insert sits at x = 20; its block-local origin maps there.
    const at20 = instances.find((i) => Math.abs(apply(i.transform, { x: 0, y: 0 }).x - 20) < 1e-9);
    expect(at20).toBeDefined();
    const end = apply(at20!.transform, { x: 1, y: 0 });
    expect(end.x).toBeCloseTo(21);
    expect(end.y).toBeCloseTo(0);
  });

  it('expands a MINSERT grid into individual instances of one definition', () => {
    // One INSERT with a 2×2 grid (column/row count 70/71, spacing 44/45).
    const minsert = [
      '0', 'INSERT', '8', '0', '2', 'SYM',
      '10', '0', '20', '0', '30', '0',
      '70', '2', '71', '2', '44', '5', '45', '5',
    ].join('\n');
    const scene = parseDxf(dxfWithBlock({ inserts: minsert }));
    const instances = scene.entities.filter(isInstance);
    expect(instances).toHaveLength(4);
    expect(scene.blocks).toHaveLength(1);
    const origins = instances
      .map((i) => apply(i.transform, { x: 0, y: 0 }))
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      .sort();
    expect(origins).toEqual(['0,0', '0,5', '5,0', '5,5']);
  });

  it('computes scene bounds from instanced geometry', () => {
    const scene = parseDxf(dxfWithBlock({ count: 5 }));
    expect(scene.bounds.valid).toBe(true);
    // Inserts span x = 0..40, plus the 1-unit line → max x ≈ 41.
    expect(scene.bounds.min.x).toBeCloseTo(0);
    expect(scene.bounds.max.x).toBeCloseTo(41);
  });
});
