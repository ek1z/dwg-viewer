/**
 * HATCH entity handler for dxf-parser.
 *
 * dxf-parser 1.1.2 ships no HATCH handler, so it silently drops the entity:
 * the dispatch loop logs "Unhandled entity HATCH" and skips every group until
 * the next 0. We register this handler to recover hatches (solid fills and
 * line patterns) — see {@link parseDxf}.
 *
 * The output is a *raw* extraction in DXF terms (angles in degrees, pattern
 * offsets as stored line-locally); {@link buildScene} converts it to the
 * normalized {@link HatchEntity} (radians, world-ready). Keeping DXF semantics
 * here and the scene mapping in the adapter mirrors how the other entities are
 * split between the parser and `adapter.ts`.
 */

/** One code/value pair, mirroring dxf-parser's IGroup without importing it. */
interface Group {
  code: number;
  value: number | string | boolean;
}

/** The slice of dxf-parser's scanner this handler relies on. */
interface Scanner {
  next(): Group;
  hasNext(): boolean;
  isEOF(): boolean;
  lastReadGroup: Group;
}

export interface RawHatchVertex {
  x: number;
  y: number;
  bulge?: number;
}

export type RawHatchEdge =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | {
      type: 'arc';
      cx: number;
      cy: number;
      radius: number;
      /** Degrees, as stored in the DXF. */
      startAngle: number;
      endAngle: number;
      ccw: boolean;
    }
  | {
      type: 'ellipse';
      cx: number;
      cy: number;
      /** Major-axis endpoint relative to centre. */
      majorX: number;
      majorY: number;
      axisRatio: number;
      /** Degrees. */
      startAngle: number;
      endAngle: number;
      ccw: boolean;
    }
  | {
      type: 'spline';
      degree: number;
      closed: boolean;
      knots: number[];
      controlPoints: Array<{ x: number; y: number; w?: number }>;
      fitPoints: Array<{ x: number; y: number }>;
    };

export type RawHatchLoop =
  | { kind: 'polyline'; closed: boolean; vertices: RawHatchVertex[] }
  | { kind: 'edges'; edges: RawHatchEdge[] };

export interface RawHatchPatternLine {
  /** Degrees. */
  angle: number;
  baseX: number;
  baseY: number;
  /** Offset to the next parallel line, in the line's own frame: along then across. */
  deltaX: number;
  deltaY: number;
  /** Dash lengths (line units): + dash, − gap, 0 dot; empty = solid. */
  dashes: number[];
}

export interface RawHatch {
  patternName: string;
  solid: boolean;
  /** AutoCAD "double" flag (group 77): mirror the pattern at 90°. */
  double: boolean;
  loops: RawHatchLoop[];
  patternLines: RawHatchPatternLine[];
  extrusion?: { x: number; y: number; z: number };
}

/** Boundary path type flag (group 92) bit 1 (value 2) marks a polyline path. */
const PATH_POLYLINE = 2;

/**
 * Parse the flat group list of a HATCH body into {@link RawHatch}.
 *
 * The walk is positional because HATCH reuses group codes across contexts
 * (10/20 is an elevation point, a polyline vertex, an edge point, and a seed
 * point). Count-prefixed sections (boundary paths 91, pattern lines 78, seeds
 * 98) hand off to sub-walkers that consume exactly their nested groups.
 */
export function parseHatch(groups: ReadonlyArray<Group>): RawHatch {
  const out: RawHatch = {
    patternName: '',
    solid: false,
    double: false,
    loops: [],
    patternLines: [],
  };
  let i = 0;
  const num = (): number => Number(groups[i]!.value);

  while (i < groups.length) {
    const { code } = groups[i]!;
    switch (code) {
      case 2:
        out.patternName = String(groups[i]!.value);
        i++;
        break;
      case 70:
        out.solid = num() !== 0;
        i++;
        break;
      case 77:
        out.double = num() !== 0;
        i++;
        break;
      case 91:
        i = parseLoops(groups, i + 1, num(), out.loops);
        break;
      case 78:
        i = parsePatternLines(groups, i + 1, num(), out.patternLines);
        break;
      case 98:
        i = skipSeeds(groups, i + 1, num());
        break;
      case 210:
        out.extrusion = { x: num(), y: 0, z: 1 };
        i++;
        break;
      case 220:
        if (out.extrusion) out.extrusion.y = num();
        i++;
        break;
      case 230:
        if (out.extrusion) out.extrusion.z = num();
        i++;
        break;
      default:
        i++;
    }
  }
  return out;
}

/** Consume `count` boundary paths starting at `start`; return the next index. */
function parseLoops(
  groups: ReadonlyArray<Group>,
  start: number,
  count: number,
  loops: RawHatchLoop[],
): number {
  let i = start;
  for (let p = 0; p < count && i < groups.length; p++) {
    // Each path opens with its type flag (92).
    while (i < groups.length && groups[i]!.code !== 92) i++;
    if (i >= groups.length) break;
    const flag = Number(groups[i]!.value);
    i++;
    if (flag & PATH_POLYLINE) {
      i = parsePolylineLoop(groups, i, loops);
    } else {
      i = parseEdgeLoop(groups, i, loops);
    }
    // Trailing source-boundary handles (97 count, then that many 330s).
    if (i < groups.length && groups[i]!.code === 97) {
      const handles = Number(groups[i]!.value);
      i++;
      for (let h = 0; h < handles && i < groups.length && groups[i]!.code === 330; h++) i++;
    }
  }
  return i;
}

function parsePolylineLoop(
  groups: ReadonlyArray<Group>,
  start: number,
  loops: RawHatchLoop[],
): number {
  let i = start;
  let hasBulge = false;
  let closed = false;
  if (i < groups.length && groups[i]!.code === 72) {
    hasBulge = Number(groups[i]!.value) !== 0;
    i++;
  }
  if (i < groups.length && groups[i]!.code === 73) {
    closed = Number(groups[i]!.value) !== 0;
    i++;
  }
  let n = 0;
  if (i < groups.length && groups[i]!.code === 93) {
    n = Number(groups[i]!.value);
    i++;
  }
  const vertices: RawHatchVertex[] = [];
  for (let v = 0; v < n && i < groups.length; v++) {
    if (groups[i]!.code !== 10) break;
    const x = Number(groups[i]!.value);
    i++;
    if (i >= groups.length || groups[i]!.code !== 20) break;
    const y = Number(groups[i]!.value);
    i++;
    let bulge: number | undefined;
    if (hasBulge && i < groups.length && groups[i]!.code === 42) {
      bulge = Number(groups[i]!.value) || undefined;
      i++;
    }
    vertices.push({ x, y, bulge });
  }
  loops.push({ kind: 'polyline', closed, vertices });
  return i;
}

function parseEdgeLoop(
  groups: ReadonlyArray<Group>,
  start: number,
  loops: RawHatchLoop[],
): number {
  let i = start;
  let n = 0;
  if (i < groups.length && groups[i]!.code === 93) {
    n = Number(groups[i]!.value);
    i++;
  }
  const edges: RawHatchEdge[] = [];
  for (let e = 0; e < n && i < groups.length; e++) {
    if (groups[i]!.code !== 72) break;
    const edgeType = Number(groups[i]!.value);
    i++;
    const r = readEdge(groups, i, edgeType);
    i = r.next;
    if (r.edge) edges.push(r.edge);
  }
  loops.push({ kind: 'edges', edges });
  return i;
}

/** Read one boundary edge of the given type; values come in documented order. */
function readEdge(
  groups: ReadonlyArray<Group>,
  start: number,
  edgeType: number,
): { edge: RawHatchEdge | null; next: number } {
  let i = start;
  // Pull the value for `code` if it is next, else undefined (no advance).
  const take = (code: number): number | undefined => {
    if (i < groups.length && groups[i]!.code === code) {
      const v = Number(groups[i]!.value);
      i++;
      return v;
    }
    return undefined;
  };

  switch (edgeType) {
    case 1: {
      const x1 = take(10) ?? 0;
      const y1 = take(20) ?? 0;
      const x2 = take(11) ?? 0;
      const y2 = take(21) ?? 0;
      return { edge: { type: 'line', x1, y1, x2, y2 }, next: i };
    }
    case 2: {
      const cx = take(10) ?? 0;
      const cy = take(20) ?? 0;
      const radius = take(40) ?? 0;
      const startAngle = take(50) ?? 0;
      const endAngle = take(51) ?? 360;
      const ccw = (take(73) ?? 1) !== 0;
      return { edge: { type: 'arc', cx, cy, radius, startAngle, endAngle, ccw }, next: i };
    }
    case 3: {
      const cx = take(10) ?? 0;
      const cy = take(20) ?? 0;
      const majorX = take(11) ?? 0;
      const majorY = take(21) ?? 0;
      const axisRatio = take(40) ?? 1;
      const startAngle = take(50) ?? 0;
      const endAngle = take(51) ?? 360;
      const ccw = (take(73) ?? 1) !== 0;
      return {
        edge: { type: 'ellipse', cx, cy, majorX, majorY, axisRatio, startAngle, endAngle, ccw },
        next: i,
      };
    }
    case 4: {
      const degree = take(94) ?? 3;
      take(73); // rational flag
      const periodic = (take(74) ?? 0) !== 0;
      const nKnots = take(95) ?? 0;
      const nCtrl = take(96) ?? 0;
      const knots: number[] = [];
      for (let k = 0; k < nKnots; k++) {
        const v = take(40);
        if (v === undefined) break;
        knots.push(v);
      }
      const controlPoints: Array<{ x: number; y: number; w?: number }> = [];
      for (let c = 0; c < nCtrl; c++) {
        const x = take(10);
        const y = take(20);
        if (x === undefined || y === undefined) break;
        const w = take(42);
        controlPoints.push({ x, y, w });
      }
      const nFit = take(97) ?? 0;
      const fitPoints: Array<{ x: number; y: number }> = [];
      for (let f = 0; f < nFit; f++) {
        const x = take(11);
        const y = take(21);
        if (x === undefined || y === undefined) break;
        fitPoints.push({ x, y });
      }
      // Optional start/end tangents.
      take(12);
      take(22);
      take(13);
      take(23);
      return {
        edge: { type: 'spline', degree, closed: periodic, knots, controlPoints, fitPoints },
        next: i,
      };
    }
    default:
      return { edge: null, next: i };
  }
}

/** Consume `count` pattern definition lines starting at `start`. */
function parsePatternLines(
  groups: ReadonlyArray<Group>,
  start: number,
  count: number,
  lines: RawHatchPatternLine[],
): number {
  let i = start;
  for (let p = 0; p < count && i < groups.length; p++) {
    while (i < groups.length && groups[i]!.code !== 53) i++;
    if (i >= groups.length) break;
    const angle = Number(groups[i]!.value);
    i++;
    const line: RawHatchPatternLine = {
      angle,
      baseX: 0,
      baseY: 0,
      deltaX: 0,
      deltaY: 0,
      dashes: [],
    };
    if (i < groups.length && groups[i]!.code === 43) (line.baseX = Number(groups[i]!.value)), i++;
    if (i < groups.length && groups[i]!.code === 44) (line.baseY = Number(groups[i]!.value)), i++;
    if (i < groups.length && groups[i]!.code === 45) (line.deltaX = Number(groups[i]!.value)), i++;
    if (i < groups.length && groups[i]!.code === 46) (line.deltaY = Number(groups[i]!.value)), i++;
    let nDashes = 0;
    if (i < groups.length && groups[i]!.code === 79) {
      nDashes = Number(groups[i]!.value);
      i++;
    }
    for (let d = 0; d < nDashes && i < groups.length && groups[i]!.code === 49; d++) {
      line.dashes.push(Number(groups[i]!.value));
      i++;
    }
    lines.push(line);
  }
  return i;
}

/** Skip `count` seed points (each a 10/20 pair). */
function skipSeeds(groups: ReadonlyArray<Group>, start: number, count: number): number {
  let i = start;
  for (let s = 0; s < count && i < groups.length; s++) {
    if (i < groups.length && groups[i]!.code === 10) i++;
    if (i < groups.length && groups[i]!.code === 20) i++;
  }
  return i;
}

/**
 * Custom dxf-parser entity handler for HATCH. Registered via
 * `parser.registerEntityHandler(...)`; the ForEntityName union in dxf-parser's
 * types omits HATCH, so the registration casts (see {@link parseDxf}).
 */
export class HatchHandler {
  public ForEntityName = 'HATCH' as const;

  public parseEntity(scanner: Scanner, curr: Group): Record<string, unknown> {
    const entity: Record<string, unknown> = { type: curr.value };
    const groups: Group[] = [];
    if (!scanner.hasNext()) return entity;
    let g = scanner.next();
    while (!scanner.isEOF() && g.code !== 0) {
      groups.push({ code: g.code, value: g.value });
      if (!scanner.hasNext()) break;
      g = scanner.next();
    }

    // Common entity properties (codes that never collide with hatch geometry).
    for (const grp of groups) {
      switch (grp.code) {
        case 8:
          entity.layer = String(grp.value);
          break;
        case 6:
          entity.lineType = String(grp.value);
          break;
        case 62:
          entity.colorIndex = Number(grp.value);
          break;
        case 370:
          entity.lineweight = Number(grp.value);
          break;
        case 48:
          entity.lineTypeScale = Number(grp.value);
          break;
        case 60:
          entity.visible = Number(grp.value) === 0;
          break;
        case 5:
          entity.handle = grp.value;
          break;
      }
    }

    entity.hatch = parseHatch(groups);
    return entity;
  }
}
