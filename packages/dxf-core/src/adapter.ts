import type {
  IDxf,
  IEntity,
  IBlock,
  ILayer,
  IPoint,
} from 'dxf-parser';
import type {
  Affine,
  Bounds,
  RGB,
  Layer,
  Scene,
  SceneEntity,
  Vec2,
  TextHAlign,
  TextVAlign,
} from './types.js';
import { IDENTITY, multiply, translation, scaling, rotation, apply } from './matrix.js';
import { ocsToAffine } from './ocs.js';
import { aciToRGB, unpackRGB, resolveColor } from './color.js';
import { resolveUnits } from './units.js';

const DEG = Math.PI / 180;
const WHITE: RGB = { r: 255, g: 255, b: 255 };
const MAX_INSERT_DEPTH = 24;

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

function lineweightToMm(raw: number | undefined): number {
  if (typeof raw !== 'number' || raw < 0) return -1;
  return raw / 100;
}

function buildLayers(dxf: IDxf): { layers: Layer[]; colors: Map<string, RGB> } {
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
    layers.push({
      name,
      color,
      visible: l.visible !== false,
      frozen: l.frozen === true,
    });
  }
  if (!colors.has('0')) {
    colors.set('0', WHITE);
    layers.push({ name: '0', color: WHITE, visible: true, frozen: false });
  }
  return { layers, colors };
}

export function buildScene(dxf: IDxf): Scene {
  const warnings: string[] = [];
  const { layers, colors } = buildLayers(dxf);

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
    return {
      layer,
      color,
      lineweight: lineweightToMm(e.lineweight),
      linetype: e.lineType || 'CONTINUOUS',
      transform,
    };
  }

  const out: SceneEntity[] = [];

  function emit(entities: ReadonlyArray<IEntity>, parent: Affine, ctx: Ctx, depth: number): void {
    for (const e of entities) {
      if (e.visible === false) continue;
      switch (e.type) {
        case 'INSERT':
          expandInsert(e, parent, ctx, depth);
          break;
        case 'DIMENSION':
          expandDimension(e, parent, ctx, depth);
          break;
        default: {
          const mapped = mapLeaf(e, parent, ctx);
          if (mapped) out.push(mapped);
          else warnOnce(`Unsupported entity type: ${e.type}`);
        }
      }
    }
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

  function expandInsert(ins: IEntity, parent: Affine, ctx: Ctx, depth: number): void {
    if (depth > MAX_INSERT_DEPTH) {
      warnOnce('INSERT nesting too deep (possible self-reference); truncated.');
      return;
    }
    const i = ins as unknown as {
      name: string;
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
    };
    const block = dxf.blocks?.[i.name];
    if (!block || !block.entities) {
      warnOnce(`INSERT references missing block: ${i.name}`);
      return;
    }
    const insLayer =
      (i.layer === '0' || !i.layer) && ctx.inheritedLayer ? ctx.inheritedLayer : i.layer || '0';
    const insColor = resolveColor(
      undefined,
      i.colorIndex,
      resolveLayerColor(insLayer),
      ctx.inheritedColor,
    );
    const childCtx: Ctx = { inheritedLayer: insLayer, inheritedColor: insColor };

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
        emit(block.entities, m, childCtx, depth + 1);
      }
    }
  }

  function expandDimension(dim: IEntity, parent: Affine, ctx: Ctx, depth: number): void {
    const d = dim as unknown as { block?: string };
    if (!d.block) return; // nothing renderable without the anonymous block
    const block = dxf.blocks?.[d.block];
    if (!block || !block.entities) {
      warnOnce(`DIMENSION references missing block: ${d.block}`);
      return;
    }
    // Anonymous dimension blocks are authored in WCS at the origin.
    emit(block.entities, parent, ctx, depth + 1);
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
      default:
        return null;
    }
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

  emit(dxf.entities ?? [], IDENTITY, TOP, 0);

  return {
    units: resolveUnits(headerNumber(dxf, '$INSUNITS')),
    layers,
    entities: out,
    bounds: computeBounds(out),
    warnings,
  };
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

/**
 * World-space bounding box. Curves are approximated by their defining points
 * (centers ± radius for arcs); good enough to frame the initial view, the
 * engine refines after tessellation if needed.
 */
function computeBounds(entities: ReadonlyArray<SceneEntity>): Bounds {
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
    }
  }

  if (minX > maxX || minY > maxY) {
    return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 }, valid: false };
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY }, valid: true };
}
