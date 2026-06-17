import { describe, it, expect } from 'vitest';
import { parseDxf } from './index.js';
import { scanLayerDefaults } from './layerDefaults.js';

// A drawing with: an LTYPE table (DASHED pattern), a layer that defaults to that
// linetype and a 0.5mm lineweight, $LTSCALE=2, and a LINE on that layer that
// sets neither linetype nor lineweight (so both resolve ByLayer), plus a LINE
// that overrides lineweight (370=100 → 1.0mm) and linetype scale (48=3).
const DXF = `0
SECTION
2
HEADER
9
$LTSCALE
40
2.0
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LTYPE
0
LTYPE
2
DASHED
3
Dashed __ __ __
73
2
40
0.75
49
0.5
49
-0.25
0
ENDTAB
0
TABLE
2
LAYER
0
LAYER
2
WALLS
70
0
62
1
6
DASHED
370
50
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
WALLS
10
0.0
20
0.0
11
100.0
21
0.0
0
LINE
8
WALLS
6
CONTINUOUS
370
100
48
3.0
10
0.0
20
0.0
11
0.0
21
50.0
0
ENDSEC
0
EOF
`;

describe('scanLayerDefaults', () => {
  const defaults = scanLayerDefaults(DXF);

  it('recovers the layer linetype (group 6) the parser drops', () => {
    expect(defaults.get('WALLS')?.linetype).toBe('DASHED');
  });

  it('recovers the layer lineweight (group 370) the parser drops', () => {
    expect(defaults.get('WALLS')?.lineweightRaw).toBe(50);
  });
});

describe('parseDxf linetype/lineweight', () => {
  const scene = parseDxf(DXF);

  it('carries the LTYPE table into the scene', () => {
    expect(scene.linetypes.DASHED).toBeDefined();
    expect(scene.linetypes.DASHED!.pattern).toEqual([0.5, -0.25]);
    expect(scene.linetypes.DASHED!.patternLength).toBeCloseTo(0.75);
  });

  it('captures the global $LTSCALE', () => {
    expect(scene.ltScale).toBe(2);
  });

  it('applies the layer linetype/lineweight defaults to the layer', () => {
    const walls = scene.layers.find((l) => l.name === 'WALLS')!;
    expect(walls.linetype).toBe('DASHED');
    expect(walls.lineweight).toBeCloseTo(0.5); // 50 / 100 mm
  });

  it('resolves ByLayer lineweight and linetype on an entity', () => {
    // The first LINE sets neither → both inherit from WALLS.
    const byLayer = scene.entities.find(
      (e) => e.type === 'polyline' && e.vertices.some((v) => v.x === 100),
    );
    expect(byLayer).toBeDefined();
    if (byLayer && byLayer.type === 'polyline') {
      expect(byLayer.linetype).toBe('DASHED');
      expect(byLayer.lineweight).toBeCloseTo(0.5);
      expect(byLayer.lineTypeScale).toBe(1);
    }
  });

  it('keeps explicit entity lineweight / linetype scale over ByLayer', () => {
    const explicit = scene.entities.find(
      (e) => e.type === 'polyline' && e.vertices.some((v) => v.y === 50),
    );
    expect(explicit).toBeDefined();
    if (explicit && explicit.type === 'polyline') {
      expect(explicit.linetype).toBe('CONTINUOUS');
      expect(explicit.lineweight).toBeCloseTo(1.0); // 100 / 100 mm
      expect(explicit.lineTypeScale).toBe(3);
    }
  });
});
