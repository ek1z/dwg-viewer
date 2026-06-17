/**
 * Normalized, framework-agnostic scene model produced from a DXF.
 *
 * All coordinates are kept as float64 (plain JS numbers) in world space.
 * Curves (arcs, ellipses, splines, polyline bulges) stay parametric here —
 * `viewer-engine` owns adaptive tessellation. Each entity carries a 2D affine
 * `transform` that maps its authored/local coordinates into world space; this
 * is where block-INSERT transforms and OCS (extrusion) corrections are baked.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 2D affine transform stored as the familiar 6-tuple (cf. CSS/Canvas
 * `matrix(a, b, c, d, e, f)`):
 *
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Layer {
  name: string;
  color: RGB;
  /** Layer turned off (DXF: negative color index) — hidden but still loaded. */
  visible: boolean;
  /** Layer frozen — hidden and excluded from regen; distinct from "off". */
  frozen: boolean;
  /** Default lineweight (mm) for ByLayer entities; -1 means "use the viewer default". */
  lineweight: number;
  /** Default linetype name for ByLayer entities (e.g. "CONTINUOUS", "DASHED"). */
  linetype: string;
}

/**
 * A linetype definition from the DXF LTYPE table. `pattern` holds the dash/gap
 * element lengths (DXF group 49): positive = dash (pen down), negative = gap
 * (pen up), 0 = dot. Lengths are in drawing units, scaled downstream by the
 * global `$LTSCALE` and each entity's `lineTypeScale`. An empty pattern means a
 * solid (continuous) line. Embedded text/shape elements are not represented.
 */
export interface Linetype {
  name: string;
  description: string;
  pattern: number[];
  /** Sum of |pattern| (DXF group 40); 0 for continuous. */
  patternLength: number;
}

export interface Bounds {
  min: Vec2;
  max: Vec2;
  /** False when the scene has no finite geometry (empty drawing). */
  valid: boolean;
}

/** Style fields shared by every renderable entity. */
export interface EntityStyle {
  layer: string;
  /** Concrete color, already resolved through ByLayer / ByBlock / ACI / true-color. */
  color: RGB;
  /** Lineweight in millimetres, already resolved through ByLayer; -1 means "use the viewer default". */
  lineweight: number;
  /** Linetype name (e.g. "CONTINUOUS", "DASHED"), resolved through ByLayer; references {@link Scene.linetypes}. */
  linetype: string;
  /** Per-entity linetype scale (DXF group 48); multiplies the global `$LTSCALE`. */
  lineTypeScale: number;
  /** Local-to-world affine (composed block + OCS transforms). */
  transform: Affine;
}

export interface PolylineEntity extends EntityStyle {
  type: 'polyline';
  /** Vertices in local coordinates; `bulge` encodes an arc to the next vertex. */
  vertices: ReadonlyArray<Vec2 & { bulge?: number }>;
  closed: boolean;
}

export interface ArcEntity extends EntityStyle {
  type: 'arc';
  center: Vec2;
  radius: number;
  /** Radians, CCW. A full circle is start 0, end 2π. */
  startAngle: number;
  endAngle: number;
}

export interface EllipseEntity extends EntityStyle {
  type: 'ellipse';
  center: Vec2;
  /** Major-axis endpoint relative to center (local coords). */
  majorAxis: Vec2;
  /** minor / major. */
  axisRatio: number;
  /** Radians, parameterized on the ellipse, CCW. */
  startAngle: number;
  endAngle: number;
}

export interface SplineEntity extends EntityStyle {
  type: 'spline';
  degree: number;
  controlPoints: ReadonlyArray<Vec2>;
  knots: ReadonlyArray<number>;
  weights?: ReadonlyArray<number>;
  closed: boolean;
  /** Present when only fit points were authored (no control points). */
  fitPoints?: ReadonlyArray<Vec2>;
}

export interface PointEntity extends EntityStyle {
  type: 'point';
  position: Vec2;
}

export interface SolidEntity extends EntityStyle {
  type: 'solid';
  /** 3 or 4 corner points (DXF stores the 4th/3rd swapped — already normalized). */
  points: ReadonlyArray<Vec2>;
}

export type TextHAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'baseline' | 'bottom' | 'middle' | 'top';

export interface TextEntity extends EntityStyle {
  type: 'text';
  position: Vec2;
  height: number;
  /** Radians, CCW. */
  rotation: number;
  text: string;
  hAlign: TextHAlign;
  vAlign: TextVAlign;
  /** Raw text may contain MTEXT formatting codes when `isMText` is set. */
  isMText: boolean;
  /** Reference rectangle width for MTEXT wrapping (0 = no wrap). */
  width: number;
}

/**
 * A placement of a reusable block definition (see {@link BlockDef}). Unlike every
 * other entity it carries no geometry of its own — only an index into
 * `Scene.blocks` and the local→world `transform` for this placement. The renderer
 * tessellates the referenced block once and shares that geometry across every
 * instance (one GPU upload, per-instance frustum culling) instead of duplicating
 * the flattened geometry per placement.
 *
 * Only block INSERTs that repeat often enough *and* whose geometry is independent
 * of per-placement context (no TEXT/MTEXT/DIMENSION children) become instances;
 * everything else is still flattened into the leaf entities above, so fidelity is
 * identical either way.
 */
export interface InstanceEntity {
  type: 'instance';
  /** Index into {@link Scene.blocks}. */
  block: number;
  /** Block-local → world affine for this placement (parent/OCS/grid/scale baked). */
  transform: Affine;
}

export type SceneEntity =
  | PolylineEntity
  | ArcEntity
  | EllipseEntity
  | SplineEntity
  | PointEntity
  | SolidEntity
  | TextEntity
  | InstanceEntity;

/**
 * A reusable block definition: the block's leaf geometry, flattened into
 * block-local coordinates (the placement transform lives on each
 * {@link InstanceEntity}). Built once per distinct (block, resolved-style)
 * combination so that ByBlock colour and layer-"0" inheritance — which depend on
 * the enclosing INSERT — stay correct while still being shared across placements.
 */
export interface BlockDef {
  /** Source block name (diagnostic; not unique — one name may yield several defs). */
  name: string;
  /** Leaf entities in block-local coordinates. Never contains nested instances. */
  entities: SceneEntity[];
  /** Block-local bounds, for culling/LOD. */
  bounds: Bounds;
}

export interface DrawingUnits {
  /** Raw $INSUNITS code (0 = unitless). */
  code: number;
  /** Human label, e.g. "mm", "m", "in". */
  name: string;
  /** Metres represented by one drawing unit; null when unitless. */
  metersPerUnit: number | null;
}

export interface Scene {
  units: DrawingUnits;
  layers: Layer[];
  /** Linetype definitions from the LTYPE table, keyed by name; referenced by `EntityStyle.linetype`. */
  linetypes: Record<string, Linetype>;
  /** Global linetype scale (`$LTSCALE` header); multiplies every dash pattern. Defaults to 1. */
  ltScale: number;
  /** Top-level renderables: leaf entities plus {@link InstanceEntity} placements. */
  entities: SceneEntity[];
  /** Block definitions referenced by {@link InstanceEntity} entries in `entities`. */
  blocks: BlockDef[];
  /**
   * Total leaf entities once instances are expanded — the "real" drawing
   * complexity, since `entities.length` collapses each instanced placement to 1.
   */
  entityCount: number;
  bounds: Bounds;
  /** Non-fatal issues encountered while building the scene (unsupported entities, etc.). */
  warnings: string[];
}
