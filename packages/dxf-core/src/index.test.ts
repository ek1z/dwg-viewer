import { describe, it, expect } from 'vitest';
import { parseDxf } from './index.js';
import { multiply, apply, ocsToAffineForTest } from './testutil.js';

const MINIMAL_DXF = `0
SECTION
2
HEADER
9
$INSUNITS
70
4
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
0
LAYER
2
0
70
0
62
7
6
CONTINUOUS
0
LAYER
2
WALLS
70
0
62
1
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
0
10
0.0
20
0.0
11
100.0
21
0.0
0
CIRCLE
8
WALLS
10
50.0
20
50.0
40
25.0
0
LWPOLYLINE
8
0
90
3
70
1
10
0.0
20
0.0
10
10.0
20
0.0
10
10.0
20
10.0
0
ENDSEC
0
EOF
`;

describe('parseDxf', () => {
  const scene = parseDxf(MINIMAL_DXF);

  it('resolves drawing units from $INSUNITS', () => {
    expect(scene.units.code).toBe(4);
    expect(scene.units.name).toBe('mm');
    expect(scene.units.metersPerUnit).toBe(0.001);
  });

  it('reads layers with colors', () => {
    const names = scene.layers.map((l) => l.name).sort();
    expect(names).toContain('0');
    expect(names).toContain('WALLS');
    const walls = scene.layers.find((l) => l.name === 'WALLS')!;
    // ACI 1 is red.
    expect(walls.color).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('maps LINE to an open 2-vertex polyline', () => {
    const line = scene.entities.find((e) => e.type === 'polyline' && e.vertices.length === 2);
    expect(line).toBeDefined();
  });

  it('maps CIRCLE to a full arc and inherits layer color', () => {
    const circle = scene.entities.find((e) => e.type === 'arc');
    expect(circle).toBeDefined();
    if (circle?.type === 'arc') {
      expect(circle.radius).toBe(25);
      expect(circle.endAngle - circle.startAngle).toBeCloseTo(Math.PI * 2);
      expect(circle.color).toEqual({ r: 255, g: 0, b: 0 }); // ByLayer → WALLS red
    }
  });

  it('maps a closed LWPOLYLINE', () => {
    const poly = scene.entities.find(
      (e) => e.type === 'polyline' && e.closed && e.vertices.length === 3,
    );
    expect(poly).toBeDefined();
  });

  it('computes valid bounds covering the geometry', () => {
    expect(scene.bounds.valid).toBe(true);
    expect(scene.bounds.min.x).toBeLessThanOrEqual(0);
    expect(scene.bounds.max.x).toBeGreaterThanOrEqual(100);
  });
});

describe('OCS arbitrary axis', () => {
  it('returns identity for +Z extrusion', () => {
    const m = ocsToAffineForTest({ x: 0, y: 0, z: 1 });
    expect(apply(m, { x: 3, y: 5 })).toEqual({ x: 3, y: 5 });
  });

  it('mirrors X for -Z extrusion', () => {
    const m = ocsToAffineForTest({ x: 0, y: 0, z: -1 });
    const p = apply(m, { x: 3, y: 5 });
    expect(p.x).toBeCloseTo(-3);
    expect(p.y).toBeCloseTo(5);
  });
});

describe('matrix composition', () => {
  it('applies inner transform before outer', () => {
    // outer translates +10x, inner scales 2x; point (1,0) -> scale -> (2,0) -> translate -> (12,0)
    const outer = [1, 0, 0, 1, 10, 0] as const;
    const inner = [2, 0, 0, 2, 0, 0] as const;
    const m = multiply(outer, inner);
    expect(apply(m, { x: 1, y: 0 })).toEqual({ x: 12, y: 0 });
  });
});
