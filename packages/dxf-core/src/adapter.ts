import type {
  IDxf,
  IEntity,
  IBlock,
  ILayer,
  IPoint,
} from 'dxf-parser';
import type {
  Affine,
  BlockDef,
  Bounds,
  RGB,
  Layer,
  Linetype,
  Scene,
  SceneEntity,
  Vec2,
  TextHAlign,
  TextVAlign,
  HatchLoop,
  HatchEdge,
  HatchPatternLine,
} from './types.js';
import type { RawHatch, RawHatchLoop, RawHatchEdge } from './hatch.js';
import { IDENTITY, multiply, translation, scaling, rotation, apply } from './matrix.js';
import { ocsToAffine } from './ocs.js';
import { aciToRGB, unpackRGB, resolveColor } from './color.js';
import { resolveUnits } from './units.js';
import type { LayerDefault } from './layerDefaults.js';

const DEG = Math.PI / 180;
const WHITE: RGB = { r: 255, g: 255, b: 255 };
const MAX_INSERT_DEPTH = 24;
/**
 * A repeated block is only worth instancing once it appears at least this many
 * times: below the threshold, flattening it into the shared per-layer geometry
 * batch is cheaper (one draw call) than spawning per-placement scene objects.
 */
const INSTANCE_THRESHOLD = 4;

function rgbKey(c: RGB | undefined): string {
  return c ? `${c.r},${c.g},${c.b}` : '-';
}

/** Context threaded down through nested block INSERTs. */
interface Ctx {
  /** Layer that entities on layer "0" inherit from the enclosing INSERT. */
  inheritedLayer: string | null;
  /** Color that ByBlock entities inherit from the enclosing INSERT. */
  inheritedColor: RGB | undefined;
}

const TOP: Ctx = { inheritedLayer: null, inheritedColor: undefined };

function vec(p: IPoint | undefined): Vec2 {
  return { x: p?.x ?? 0, y: p?.y ?? 0 };
}

/** DXF lineweight (group 370) is in 1/100 mm; negative codes mean ByLayer/ByBlock/Default. */
function lineweightToMm(raw: number | undefined): number {
  if (typeof raw !== 'number' || raw < 0) return -1;
  return raw / 100;
}

/** Linetype name that means "inherit from the layer" (or absent). */
function isByLayerLinetype(name: string | undefined): boolean {
  if (!name) return true;
  const u = name.toUpperCase();
  // ByBlock has no inherited-linetype channel here, so fall back to the layer too.
  return u === 'BYLAYER' || u === 'BYBLOCK';
}

function buildLayers(
  dxf: IDxf,
  defaults: Map<string, LayerDefault>,
): { layers: Layer[]; colors: Map<string, RGB>; byName: Map<string, Layer> } {
  const layers: Layer[] = [];
  const colors = new Map<string, RGB>();
  const table = dxf.tables?.layer?.layers ?? {};
  for (const name of Object.keys(table)) {
    const l = table[name] as ILayer;
    const color =
      typeof l.color === 'number' && l.color >= 0
        ? unpackRGB(l.color)
        : aciToRGB(Math.abs(l.colorIndex ?? 7));
    colors.set(name, color);
    const def = defaults.get(name);
    layers.push({
      name,
      color,
      visible: l.visible !== false,
      frozen: l.frozen === true,
      lineweight: lineweightToMm(def?.lineweightRaw),
      linetype: def?.linetype || 'CONTINUOUS',
    });
  }
  if (!colors.has('0')) {
    colors.set('0', WHITE);
    layers.push({ name: '0', color: WHITE, visible: true, frozen: false, lineweight: -1, linetype: 'CONTINUOUS' });
  }
  const byName = new Map(layers.map((l) => [l.name, l]));
  return { layers, colors, byName };
}

/** Build the LTYPE table into the scene's keyed linetype map. */
function buildLinetypes(dxf: IDxf): Record<string, Linetype> {
  const out: Record<string, Linetype> = {};
  // dxf-parser's `.d.ts` types `pattern` as string[], but the reader pushes the
  // numeric group-49 values — coerce defensively so dash math stays in numbers.
  const table = (dxf.tables?.lineType?.lineTypes ?? {}) as Record<
    string,
    { name?: string; description?: string; pattern?: Array<number | string>; patternLength?: number }
  >;
  for (const key of Object.keys(table)) {
    const lt = table[key]!;
    const pattern = (lt.pattern ?? []).map((v) => (typeof v === 'number' ? v : Number(v))).filter(Number.isFinite);
    out[key] = {
      name: lt.name ?? key,
      description: lt.description ?? '',
      pattern,
      patternLength: lt.patternLength ?? pattern.reduce((s, v) => s + Math.abs(v), 0),
    };
  }
  return out;
}

export function buildScene(dxf: IDxf, layerDefaults: Map<string, LayerDefault> = new Map()): Scene {
  const warnings: string[] = [];
  const { layers, colors, byName } = buildLayers(dxf, layerDefaults);
  const linetypes = buildLinetypes(dxf);
  const ltScaleRaw = headerNumber(dxf, '$LTSCALE');
  const ltScale = typeof ltScaleRaw === 'number' && ltScaleRaw > 0 ? ltScaleRaw : 1;

  const resolveLayerColor = (name: string): RGB => colors.get(name) ?? WHITE;

  /** Common style resolution for any leaf entity. */
  function style(e: IEntity, transform: Affine, ctx: Ctx) {
    const ownLayer = e.layer || '0';
    const layer =
      (ownLayer === '0' || !e.layer) && ctx.inheritedLayer
        ? ctx.inheritedLayer
        : ownLayer;
    const layerColor = resolveLayerColor(layer);
    // dxf-parser conflates ACI and true-color into `color`, so we resolve from
    // `colorIndex` alone and fall back to the layer color for inherited/true-color.
    const color = resolveColor(undefined, e.colorIndex, layerColor, ctx.inheritedColor);
    const layerDef = byName.get(layer);
    // Resolve ByLayer: a missing/negative lineweight or a ByLayer/ByBlock
    // linetype falls back to the layer's default.
    let lineweight = lineweightToMm(e.lineweight);
    if (lineweight === -1 && layerDef) lineweight = layerDef.lineweight;
    const linetype = isByLayerLinetype(e.lineType)
      ? layerDef?.linetype || 'CONTINUOUS'
      : e.lineType;
    const ltScaleOwn = (e as { lineTypeScale?: number }).lineTypeScale;
    return {
      layer,
      color,
      lineweight,
      linetype,
      lineTypeScale: typeof ltScaleOwn === 'number' && ltScaleOwn > 0 ? ltScaleOwn : 1,
      transform,
    };
  }

  const out: SceneEntity[] = [];
  const blocks: BlockDef[] = [];
  /** (block name + resolved style) → index into `blocks`, so identical placements share a def. */
  const blockIndex = new Map<string, number>();
  /** Cached instanceability per block name (does its tree avoid text/dimensions?). */
  const instanceableCache = new Map<string, boolean>();
  /** Per-def placement counts, gathered up front so we only instance frequently-repeated blocks. */
  const placementCounts = new Map<string, number>();
  /** Leaf-entity total once instances are expanded (instances themselves count their def's leaves). */
  let leafCount = 0;

  function emit(
    target: SceneEntity[],
    entities: ReadonlyArray<IEntity>,
    parent: Affine,
    ctx: Ctx,
    depth: number,
  ): void {
    for (const e of entities) {
      if (e.visible === false) continue;
      switch (e.type) {
        case 'INSERT':
          // Only top-level INSERTs are eligible for instancing; nested ones flatten
          // into their parent's definition (which is itself shared once).
          if (depth === 0 && tryEmitInstance(target, e, parent, ctx)) break;
          expandInsert(target, e, parent, ctx, depth);
          break;
        case 'DIMENSION':
          expandDimension(target, e, parent, ctx, depth);
          break;
        default: {
          const mapped = mapLeaf(e, parent, ctx);
          if (mapped) {
            target.push(mapped);
            if (target === out) leafCount++;
          } else warnOnce(`Unsupported entity type: ${e.type}`);
        }
      }
    }
  }

  /** Resolved layer + colour an INSERT contributes to its children (ByBlock / layer-"0"). */
  function insertContext(i: { layer?: string; colorIndex?: number }, ctx: Ctx): Ctx {
    const insLayer =
      (i.layer === '0' || !i.layer) && ctx.inheritedLayer ? ctx.inheritedLayer : i.layer || '0';
    const insColor = resolveColor(
      undefined,
      i.colorIndex,
      resolveLayerColor(insLayer),
      ctx.inheritedColor,
    );
    return { inheritedLayer: insLayer, inheritedColor: insColor };
  }

  /**
   * True when every entity reachable from `name` is plain geometry — no
   * TEXT/MTEXT (rendered as separate SDF meshes, not instanceable here) and no
   * DIMENSION (anonymous sub-blocks), and no missing/cyclic nested block.
   */
  function instanceable(name: string, stack: Set<string> = new Set()): boolean {
    const cached = instanceableCache.get(name);
    if (cached !== undefined) return cached;
    if (stack.has(name)) return false; // self-reference
    const block = dxf.blocks?.[name];
    if (!block?.entities) {
      instanceableCache.set(name, false);
      return false;
    }
    stack.add(name);
    let ok = true;
    for (const e of block.entities) {
      if (e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'DIMENSION') {
        ok = false;
        break;
      }
      if (e.type === 'INSERT') {
        const n = (e as unknown as { name?: string }).name;
        if (!n || !instanceable(n, stack)) {
          ok = false;
          break;
        }
      }
    }
    stack.delete(name);
    instanceableCache.set(name, ok);
    return ok;
  }

  /** Pre-pass: tally how often each (block, resolved-style) appears at top level. */
  function countPlacements(entities: ReadonlyArray<IEntity>): void {
    for (const e of entities) {
      if (e.visible === false || e.type !== 'INSERT') continue;
      const i = e as unknown as InsertProps;
      if (!i.name || !instanceable(i.name)) continue;
      const childCtx = insertContext(i, TOP);
      const key = defKey(i.name, childCtx);
      const cells = Math.max(1, i.columnCount ?? 1) * Math.max(1, i.rowCount ?? 1);
      placementCounts.set(key, (placementCounts.get(key) ?? 0) + cells);
    }
  }

  function defKey(name: string, ctx: Ctx): string {
    return `${name} ${ctx.inheritedLayer ?? '-'} ${rgbKey(ctx.inheritedColor)}`;
  }

  /**
   * If `ins` references a sufficiently-repeated instanceable block, push one
   * {@link InstanceEntity} per grid cell (sharing a single block definition) and
   * return true; otherwise return false so the caller falls back to flattening.
   */
  function tryEmitInstance(target: SceneEntity[], ins: IEntity, parent: Affine, ctx: Ctx): boolean {
    const i = ins as unknown as InsertProps;
    if (!i.name || !instanceable(i.name)) return false;
    const block = dxf.blocks?.[i.name];
    if (!block?.entities) return false;
    const childCtx = insertContext(i, ctx);
    const key = defKey(i.name, childCtx);
    if ((placementCounts.get(key) ?? 0) < INSTANCE_THRESHOLD) return false;

    let blockIdx = blockIndex.get(key);
    if (blockIdx === undefined) {
      const defEntities: SceneEntity[] = [];
      // Block-local geometry: base point baked in, but not this INSERT's placement.
      emit(defEntities, block.entities, blockBase(block), childCtx, 1);
      blockIdx = blocks.length;
      blocks.push({
        name: i.name,
        entities: defEntities,
        bounds: computeBounds(defEntities, blocks),
      });
      blockIndex.set(key, blockIdx);
    }
    const def = blocks[blockIdx]!;

    const ocs = ocsToAffine(toVec3(i.extrusionDirection));
    const pos = vec(i.position);
    const sx = i.xScale ?? 1;
    const sy = i.yScale ?? 1;
    const rot = (i.rotation ?? 0) * DEG;
    const cols = Math.max(1, i.columnCount ?? 1);
    const rows = Math.max(1, i.rowCount ?? 1);
    const colSpacing = i.columnSpacing ?? 0;
    const rowSpacing = i.rowSpacing ?? 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // world ∘ OCS ∘ T(pos) ∘ R ∘ T(grid) ∘ S — base is already in the def.
        let m = multiply(parent, ocs);
        m = multiply(m, translation(pos.x, pos.y));
        m = multiply(m, rotation(rot));
        if (colSpacing || rowSpacing) m = multiply(m, translation(c * colSpacing, r * rowSpacing));
        m = multiply(m, scaling(sx, sy));
        target.push({ type: 'instance', block: blockIdx, transform: m });
        if (target === out) leafCount += def.entities.length;
      }
    }
    return true;
  }

  const seenWarnings = new Set<string>();
  function warnOnce(msg: string): void {
    if (!seenWarnings.has(msg)) {
      seenWarnings.add(msg);
      warnings.push(msg);
    }
  }

  function blockBase(block: IBlock): Affine {
    const b = vec(block.position);
    return translation(-b.x, -b.y);
  }

  function expandInsert(
    target: SceneEntity[],
    ins: IEntity,
    parent: Affine,
    ctx: Ctx,
    depth: number,
  ): void {
    if (depth > MAX_INSERT_DEPTH) {
      warnOnce('INSERT nesting too deep (possible self-reference); truncated.');
      return;
    }
    const i = ins as unknown as InsertProps;
    if (!i.name) return;
    const block = dxf.blocks?.[i.name];
    if (!block || !block.entities) {
      warnOnce(`INSERT references missing block: ${i.name}`);
      return;
    }
    const childCtx = insertContext(i, ctx);

    const ocs = ocsToAffine(toVec3(i.extrusionDirection));
    const pos = vec(i.position);
    const sx = i.xScale ?? 1;
    const sy = i.yScale ?? 1;
    const rot = (i.rotation ?? 0) * DEG;
    const cols = Math.max(1, i.columnCount ?? 1);
    const rows = Math.max(1, i.rowCount ?? 1);
    const colSpacing = i.columnSpacing ?? 0;
    const rowSpacing = i.rowSpacing ?? 0;
    const base = blockBase(block);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // world ∘ OCS ∘ T(pos) ∘ R ∘ T(grid) ∘ S ∘ T(-base)
        let m = multiply(parent, ocs);
        m = multiply(m, translation(pos.x, pos.y));
        m = multiply(m, rotation(rot));
        if (colSpacing || rowSpacing) m = multiply(m, translation(c * colSpacing, r * rowSpacing));
        m = multiply(m, scaling(sx, sy));
        m = multiply(m, base);
        emit(target, block.entities, m, childCtx, depth + 1);
      }
    }
  }

  function expandDimension(
    target: SceneEntity[],
    dim: IEntity,
    parent: Affine,
    ctx: Ctx,
    depth: number,
  ): void {
    const d = dim as unknown as { block?: string };
    if (!d.block) return; // nothing renderable without the anonymous block
    const block = dxf.blocks?.[d.block];
    if (!block || !block.entities) {
      warnOnce(`DIMENSION references missing block: ${d.block}`);
      return;
    }
    // Anonymous dimension blocks are authored in WCS at the origin.
    emit(target, block.entities, parent, ctx, depth + 1);
  }

  function mapLeaf(e: IEntity, parent: Affine, ctx: Ctx): SceneEntity | null {
    switch (e.type) {
      case 'LINE': {
        const l = e as unknown as { vertices?: IPoint[] };
        const v = l.vertices ?? [];
        if (v.length < 2) return null;
        return {
          type: 'polyline',
          ...style(e, parent, ctx), // LINE endpoints are WCS; no OCS.
          vertices: v.map((p) => ({ x: p.x, y: p.y })),
          closed: false,
        };
      }
      case 'LWPOLYLINE': {
        const p = e as unknown as {
          vertices?: Array<IPoint & { bulge?: number }>;
          shape?: boolean;
          elevation?: number;
          extrusionDirectionX?: number;
          extrusionDirectionY?: number;
          extrusionDirectionZ?: number;
        };
        const verts = p.vertices ?? [];
        if (verts.length < 2) return null;
        const ocs = ocsToAffine(
          extrusionXYZ(p.extrusionDirectionX, p.extrusionDirectionY, p.extrusionDirectionZ),
          p.elevation ?? 0,
        );
        return {
          type: 'polyline',
          ...style(e, multiply(parent, ocs), ctx),
          vertices: verts.map((vtx) => ({ x: vtx.x, y: vtx.y, bulge: vtx.bulge || undefined })),
          closed: p.shape === true,
        };
      }
      case 'POLYLINE': {
        const p = e as unknown as {
          vertices?: Array<IPoint & { bulge?: number }>;
          shape?: boolean;
          is3dPolyline?: boolean;
          extrusionDirection?: IPoint;
        };
        const verts = p.vertices ?? [];
        if (verts.length < 2) return null;
        const ocs = p.is3dPolyline ? IDENTITY : ocsToAffine(toVec3(p.extrusionDirection));
        return {
          type: 'polyline',
          ...style(e, multiply(parent, ocs), ctx),
          vertices: verts.map((vtx) => ({ x: vtx.x, y: vtx.y, bulge: vtx.bulge || undefined })),
          closed: p.shape === true,
        };
      }
      case 'CIRCLE': {
        const c = e as unknown as { center?: IPoint; radius?: number };
        if (!c.center || !c.radius) return null;
        return {
          type: 'arc',
          ...style(e, parent, ctx),
          center: vec(c.center),
          radius: c.radius,
          startAngle: 0,
          endAngle: Math.PI * 2,
        };
      }
      case 'ARC': {
        const a = e as unknown as {
          center?: IPoint;
          radius?: number;
          startAngle?: number;
          endAngle?: number;
          extrusionDirectionX?: number;
          extrusionDirectionY?: number;
          extrusionDirectionZ?: number;
        };
        if (!a.center || !a.radius) return null;
        const ocs = ocsToAffine(
          extrusionXYZ(a.extrusionDirectionX, a.extrusionDirectionY, a.extrusionDirectionZ),
        );
        return {
          type: 'arc',
          ...style(e, multiply(parent, ocs), ctx),
          center: vec(a.center),
          radius: a.radius,
          startAngle: a.startAngle ?? 0,
          endAngle: a.endAngle ?? Math.PI * 2,
        };
      }
      case 'ELLIPSE': {
        const el = e as unknown as {
          center?: IPoint;
          majorAxisEndPoint?: IPoint;
          axisRatio?: number;
          startAngle?: number;
          endAngle?: number;
        };
        if (!el.center || !el.majorAxisEndPoint) return null;
        return {
          type: 'ellipse',
          ...style(e, parent, ctx),
          center: vec(el.center),
          majorAxis: vec(el.majorAxisEndPoint),
          axisRatio: el.axisRatio ?? 1,
          startAngle: el.startAngle ?? 0,
          endAngle: el.endAngle ?? Math.PI * 2,
        };
      }
      case 'SPLINE': {
        const s = e as unknown as {
          controlPoints?: IPoint[];
          fitPoints?: IPoint[];
          knotValues?: number[];
          degreeOfSplineCurve?: number;
          closed?: boolean;
        };
        const cps = (s.controlPoints ?? []).map(vec);
        const fps = (s.fitPoints ?? []).map(vec);
        if (cps.length < 2 && fps.length < 2) return null;
        return {
          type: 'spline',
          ...style(e, parent, ctx),
          degree: s.degreeOfSplineCurve ?? 3,
          controlPoints: cps,
          knots: s.knotValues ?? [],
          closed: s.closed === true,
          fitPoints: fps.length ? fps : undefined,
        };
      }
      case 'POINT': {
        const p = e as unknown as { position?: IPoint };
        if (!p.position) return null;
        return { type: 'point', ...style(e, parent, ctx), position: vec(p.position) };
      }
      case 'SOLID':
      case '3DFACE': {
        const s = e as unknown as { points?: IPoint[] };
        const pts = s.points ?? [];
        if (pts.length < 3) return null;
        // SOLID stores corners as 0,1,3,2; reorder to a simple polygon ring.
        const ring =
          pts.length >= 4
            ? [pts[0]!, pts[1]!, pts[3]!, pts[2]!]
            : [pts[0]!, pts[1]!, pts[2]!];
        return { type: 'solid', ...style(e, parent, ctx), points: ring.map(vec) };
      }
      case 'TEXT':
      case 'MTEXT': {
        return mapText(e, parent, ctx);
      }
      case 'HATCH': {
        return mapHatch(e, parent, ctx);
      }
      default:
        return null;
    }
  }

  function mapHatch(e: IEntity, parent: Affine, ctx: Ctx): SceneEntity | null {
    const raw = (e as unknown as { hatch?: RawHatch }).hatch;
    if (!raw || !raw.loops.length) return null;
    const ocs = ocsToAffine(toVec3(raw.extrusion));
    const loops = raw.loops.map(convertHatchLoop).filter((l): l is HatchLoop => l !== null);
    if (!loops.length) return null;
    // A pattern hatch with no usable definition lines can't draw lines; treat it
    // as solid so the region still reads as filled rather than vanishing.
    const pattern = raw.solid ? [] : raw.patternLines.map(convertHatchPatternLine);
    const solid = raw.solid || pattern.length === 0;
    return {
      type: 'hatch',
      ...style(e, multiply(parent, ocs), ctx),
      loops,
      solid,
      pattern,
      double: raw.double,
    };
  }

  function mapText(e: IEntity, parent: Affine, ctx: Ctx): SceneEntity | null {
    const isM = e.type === 'MTEXT';
    const t = e as unknown as {
      text?: string;
      startPoint?: IPoint;
      endPoint?: IPoint;
      position?: IPoint;
      textHeight?: number;
      height?: number;
      rotation?: number;
      width?: number;
      halign?: number;
      valign?: number;
      attachmentPoint?: number;
    };
    const text = t.text ?? '';
    if (!text) return null;
    const height = (isM ? t.height : t.textHeight) ?? 1;
    let position: Vec2;
    let hAlign: TextHAlign = 'left';
    let vAlign: TextVAlign = 'baseline';
    if (isM) {
      position = vec(t.position);
      const ap = t.attachmentPoint ?? 1; // 1..9 grid: TL,TC,TR,ML,MC,MR,BL,BC,BR
      hAlign = (['left', 'center', 'right'] as const)[(ap - 1) % 3] ?? 'left';
      vAlign = (['top', 'middle', 'bottom'] as const)[Math.floor((ap - 1) / 3)] ?? 'top';
    } else {
      const ha = t.halign ?? 0;
      const va = t.valign ?? 0;
      hAlign = ha === 1 ? 'center' : ha === 2 ? 'right' : 'left';
      vAlign = va === 1 ? 'bottom' : va === 2 ? 'middle' : va === 3 ? 'top' : 'baseline';
      position = vec(ha === 0 && va === 0 ? t.startPoint : (t.endPoint ?? t.startPoint));
    }
    return {
      type: 'text',
      ...style(e, parent, ctx),
      position,
      height,
      rotation: (t.rotation ?? 0) * DEG,
      text,
      hAlign,
      vAlign,
      isMText: isM,
      width: t.width ?? 0,
    };
  }

  countPlacements(dxf.entities ?? []);
  emit(out, dxf.entities ?? [], IDENTITY, TOP, 0);

  return {
    units: resolveUnits(headerNumber(dxf, '$INSUNITS')),
    layers,
    linetypes,
    ltScale,
    entities: out,
    blocks,
    entityCount: leafCount,
    bounds: computeBounds(out, blocks),
    warnings,
  };
}

/** dxf-parser shape for an INSERT, used in several places here. */
interface InsertProps {
  name?: string;
  position?: IPoint;
  xScale?: number;
  yScale?: number;
  rotation?: number;
  columnCount?: number;
  rowCount?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  extrusionDirection?: IPoint;
  layer?: string;
  colorIndex?: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function toVec3(p: IPoint | undefined): Vec3 | undefined {
  if (!p) return undefined;
  return { x: p.x ?? 0, y: p.y ?? 0, z: (p as IPoint).z ?? 1 };
}

function extrusionXYZ(x?: number, y?: number, z?: number): Vec3 | undefined {
  if (x === undefined && y === undefined && z === undefined) return undefined;
  return { x: x ?? 0, y: y ?? 0, z: z ?? 1 };
}

function headerNumber(dxf: IDxf, key: string): number | undefined {
  const v = dxf.header?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** Raw (DXF-flavoured) HATCH boundary loop → normalized scene loop, or null. */
function convertHatchLoop(raw: RawHatchLoop): HatchLoop | null {
  if (raw.kind === 'polyline') {
    if (raw.vertices.length < 2) return null;
    return {
      kind: 'polyline',
      closed: raw.closed,
      vertices: raw.vertices.map((v) => ({ x: v.x, y: v.y, bulge: v.bulge || undefined })),
    };
  }
  const edges = raw.edges.map(convertHatchEdge).filter((e): e is HatchEdge => e !== null);
  return edges.length ? { kind: 'edges', edges } : null;
}

/** Raw boundary edge → scene edge (angles degrees → radians), or null. */
function convertHatchEdge(raw: RawHatchEdge): HatchEdge | null {
  switch (raw.type) {
    case 'line':
      return { type: 'line', a: { x: raw.x1, y: raw.y1 }, b: { x: raw.x2, y: raw.y2 } };
    case 'arc':
      return {
        type: 'arc',
        center: { x: raw.cx, y: raw.cy },
        radius: raw.radius,
        startAngle: raw.startAngle * DEG,
        endAngle: raw.endAngle * DEG,
        ccw: raw.ccw,
      };
    case 'ellipse':
      return {
        type: 'ellipse',
        center: { x: raw.cx, y: raw.cy },
        majorAxis: { x: raw.majorX, y: raw.majorY },
        axisRatio: raw.axisRatio,
        startAngle: raw.startAngle * DEG,
        endAngle: raw.endAngle * DEG,
        ccw: raw.ccw,
      };
    case 'spline':
      if (raw.controlPoints.length < 2) return null;
      return {
        type: 'spline',
        degree: raw.degree,
        controlPoints: raw.controlPoints.map((p) => ({ x: p.x, y: p.y })),
        knots: raw.knots,
        closed: raw.closed,
      };
  }
}

/**
 * Raw pattern definition line → scene pattern family. DXF stores the offset in
 * the line's own frame (delta-x along, delta-y across), so delta-y is exactly
 * the perpendicular spacing and delta-x the per-line shift along the direction.
 */
function convertHatchPatternLine(raw: {
  angle: number;
  baseX: number;
  baseY: number;
  deltaX: number;
  deltaY: number;
  dashes: number[];
}): HatchPatternLine {
  return {
    angle: raw.angle * DEG,
    base: { x: raw.baseX, y: raw.baseY },
    spacing: raw.deltaY,
    along: raw.deltaX,
    dashes: raw.dashes,
  };
}

/**
 * World-space bounding box. Curves are approximated by their defining points
 * (centers ± radius for arcs); good enough to frame the initial view, the
 * engine refines after tessellation if needed.
 */
function computeBounds(
  entities: ReadonlyArray<SceneEntity>,
  blocks: ReadonlyArray<BlockDef>,
): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const add = (p: Vec2) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  for (const e of entities) {
    switch (e.type) {
      case 'instance': {
        const b = blocks[e.block]?.bounds;
        if (b?.valid) {
          // Transform all four corners — rotation/shear can extend the AABB.
          for (const corner of [
            { x: b.min.x, y: b.min.y },
            { x: b.max.x, y: b.min.y },
            { x: b.max.x, y: b.max.y },
            { x: b.min.x, y: b.max.y },
          ])
            add(apply(e.transform, corner));
        }
        break;
      }
      case 'polyline':
        for (const v of e.vertices) add(apply(e.transform, v));
        break;
      case 'arc':
        for (const corner of [
          { x: e.center.x - e.radius, y: e.center.y - e.radius },
          { x: e.center.x + e.radius, y: e.center.y + e.radius },
        ])
          add(apply(e.transform, corner));
        break;
      case 'ellipse': {
        const rx = Math.hypot(e.majorAxis.x, e.majorAxis.y);
        const ry = rx * e.axisRatio;
        const r = Math.max(rx, ry);
        for (const corner of [
          { x: e.center.x - r, y: e.center.y - r },
          { x: e.center.x + r, y: e.center.y + r },
        ])
          add(apply(e.transform, corner));
        break;
      }
      case 'spline':
        for (const p of e.controlPoints) add(apply(e.transform, p));
        if (e.fitPoints) for (const p of e.fitPoints) add(apply(e.transform, p));
        break;
      case 'solid':
        for (const p of e.points) add(apply(e.transform, p));
        break;
      case 'point':
        add(apply(e.transform, e.position));
        break;
      case 'text':
        add(apply(e.transform, e.position));
        break;
      case 'hatch':
        for (const loop of e.loops) {
          if (loop.kind === 'polyline') {
            for (const v of loop.vertices) add(apply(e.transform, v));
          } else {
            for (const edge of loop.edges) {
              if (edge.type === 'line') {
                add(apply(e.transform, edge.a));
                add(apply(e.transform, edge.b));
              } else if (edge.type === 'arc') {
                add(apply(e.transform, { x: edge.center.x - edge.radius, y: edge.center.y - edge.radius }));
                add(apply(e.transform, { x: edge.center.x + edge.radius, y: edge.center.y + edge.radius }));
              } else if (edge.type === 'ellipse') {
                const r = Math.hypot(edge.majorAxis.x, edge.majorAxis.y);
                add(apply(e.transform, { x: edge.center.x - r, y: edge.center.y - r }));
                add(apply(e.transform, { x: edge.center.x + r, y: edge.center.y + r }));
              } else {
                for (const p of edge.controlPoints) add(apply(e.transform, p));
              }
            }
          }
        }
        break;
    }
  }

  if (minX > maxX || minY > maxY) {
    return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 }, valid: false };
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY }, valid: true };
}
