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
  /** Lineweight in millimetres; -1 means "default / by layer". */
  lineweight: number;
  /** Linetype name (e.g. "CONTINUOUS", "DASHED"); dashing handled downstream. */
  linetype: string;
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

export type SceneEntity =
  | PolylineEntity
  | ArcEntity
  | EllipseEntity
  | SplineEntity
  | PointEntity
  | SolidEntity
  | TextEntity;

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
  entities: SceneEntity[];
  bounds: Bounds;
  /** Non-fatal issues encountered while building the scene (unsupported entities, etc.). */
  warnings: string[];
}
