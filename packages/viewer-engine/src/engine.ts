/// <reference path="./troika-three-text.d.ts" />
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import {
  apply,
  decompose,
  multiply,
  type Affine,
  type BlockDef,
  type InstanceEntity,
  type Layer,
  type Scene,
  type SceneEntity,
  type TextEntity,
  type Vec2,
} from '@dwg-viewer/dxf-core';
import { SnapBuilder, type SnapIndex, type SnapResult } from '@dwg-viewer/measure';
import { Text as TroikaText } from 'troika-three-text';
import { tessellateArc, tessellateEllipse, tessellatePolyline, tessellateSpline } from './tessellate.js';
import { anchorX, anchorY, CAP_HEIGHT_RATIO, decodeText } from './text.js';

export interface ViewerOptions {
  /** Background color (hex). Default dark CAD grey. */
  background?: number;
  /** Constant on-screen line width in CSS pixels. */
  lineWidth?: number;
  /**
   * URL of a TrueType/OpenType/WOFF font for rendering TEXT/MTEXT. SHX fonts
   * aren't embedded in DXF, so glyphs are substituted (plan §3). When omitted,
   * troika fetches its default font from a CDN — pass a self-hosted URL to keep
   * everything on-device.
   */
  fontUrl?: string;
}

interface LayerObjects {
  group: THREE.Group;
}

/** Per-layer geometry accumulator while batching a scene or a block definition. */
interface Bucket {
  segPositions: number[];
  segColors: number[];
  triPositions: number[];
  triColors: number[];
  pointPositions: number[];
  pointColors: number[];
}

function emptyBucket(): Bucket {
  return {
    segPositions: [],
    segColors: [],
    triPositions: [],
    triColors: [],
    pointPositions: [],
    pointColors: [],
  };
}

/**
 * Pre-built, shareable GPU geometry for one layer of a block definition. Every
 * placement of the block reuses these buffers/materials (uploaded once), drawing
 * a cheap per-instance object whose only per-placement state is a transform —
 * this is what keeps memory O(unique blocks) rather than O(placements).
 */
interface BlockLayerParts {
  layer: string;
  /** Make a scene object for one placement, sharing the underlying geometry. */
  build: (matrix: THREE.Matrix4) => THREE.Object3D;
}

const DEFAULT_BG = 0x1e1e1e;
const DEFAULT_LINE_WIDTH = 1.4;
const ZERO: Vec2 = { x: 0, y: 0 };

/** Give an object a fixed local matrix (no per-frame recompute) and return it. */
function placed<T extends THREE.Object3D>(obj: T, matrix: THREE.Matrix4): T {
  obj.matrixAutoUpdate = false;
  obj.matrix.copy(matrix);
  obj.matrixWorldNeedsUpdate = true;
  return obj;
}

/**
 * WebGL viewer for a normalized DXF scene.
 *
 * Precision strategy (plan §5): the parsed scene stays float64; on load we
 * rebase to a local origin (`offset`) and push only f32 to the GPU. World
 * coordinates handed back out (`screenToWorld`) re-add the offset so downstream
 * measurement runs against true f64 values.
 */
export class ViewerEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private readonly lineWidth: number;

  private readonly layers = new Map<string, LayerObjects>();
  private readonly materials: LineMaterial[] = [];
  /** Every geometry/material created for the current scene, disposed on clear. */
  private readonly sceneDisposables: Array<{ dispose(): void }> = [];
  /** Troika text meshes, retained so they can be disposed on scene clear. */
  private readonly textObjects: TroikaText[] = [];
  /** Substitution font URL for TEXT/MTEXT; undefined falls back to troika's default. */
  private readonly fontUrl?: string;

  /** Rebasing offset: worldLocal = world − offset. */
  private offset: Vec2 = { x: 0, y: 0 };
  /** Most recently loaded scene, retained so `fitToView()` can reframe. */
  private currentScene: Scene | null = null;
  /** World-local point currently at screen center. */
  private center: Vec2 = { x: 0, y: 0 };
  /** CSS pixels per world unit. */
  private scale = 1;

  /** Snap geometry for the current scene (true world f64); null until a scene loads. */
  private snapIndex: SnapIndex | null = null;
  /** Listeners notified whenever the camera (pan/zoom/fit/resize) changes. */
  private readonly changeListeners = new Set<() => void>();
  /** When false, the left mouse button is reserved for tools (e.g. measuring) instead of panning. */
  private panLeftButton = true;

  private renderScheduled = false;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: ViewerOptions = {},
  ) {
    this.lineWidth = options.lineWidth ?? DEFAULT_LINE_WIDTH;
    this.fontUrl = options.fontUrl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setClearColor(options.background ?? DEFAULT_BG, 1);
    this.camera.position.z = 10;
    this.attachControls();
    this.resize();
  }

  /** Replace the rendered scene. Frames the drawing on load. */
  loadScene(parsed: Scene): void {
    this.clearScene();
    this.currentScene = parsed;
    const b = parsed.bounds;
    this.offset = b.valid
      ? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }
      : { x: 0, y: 0 };

    const layerColor = new Map(parsed.layers.map((l) => [l.name, l]));

    const buckets = new Map<string, Bucket>();
    const bucketFor = (layer: string): Bucket => {
      let bk = buckets.get(layer);
      if (!bk) buckets.set(layer, (bk = emptyBucket()));
      return bk;
    };

    // Repeated blocks are preserved as instances (shared geometry, one draw per
    // placement); everything else is flattened into the per-layer merge below.
    const snap = new SnapBuilder();
    const instances: InstanceEntity[] = [];
    for (const e of parsed.entities) {
      if (e.type === 'instance') {
        instances.push(e);
        this.addInstanceSnap(e, parsed, snap);
        continue;
      }
      this.appendEntity(e, bucketFor(e.layer), this.offset);
      this.addEntitySnap(e, snap);
    }
    this.snapIndex = snap.build();

    // One merged geometry per layer for all flattened (non-instanced) entities.
    const identity = new THREE.Matrix4();
    for (const [layerName, bk] of buckets) {
      const group = this.layerGroup(layerName, layerColor);
      for (const make of this.bucketToParts(bk)) group.add(make(identity));
    }

    // Instanced blocks: tessellate each definition once into shared GPU buffers,
    // then add a lightweight per-placement object (frustum-cullable) per layer.
    if (instances.length) {
      const blockParts = parsed.blocks.map((def) => this.buildBlockParts(def));
      const m4 = new THREE.Matrix4();
      for (const inst of instances) {
        const parts = blockParts[inst.block];
        if (!parts) continue;
        this.affineToMatrix(inst.transform, m4);
        for (const part of parts) this.layerGroup(part.layer, layerColor).add(part.build(m4));
      }
    }

    // Text is rendered as SDF geometry (troika), not batched into the buckets,
    // so it runs as a separate pass once the line/mesh layer groups exist.
    for (const e of parsed.entities) {
      if (e.type === 'text') this.appendText(e, layerColor);
    }

    this.fitToView(parsed);
    this.updateMaterialResolution();
    this.requestRender();
  }

  /**
   * Turn a batched bucket into shareable GPU geometry, returning factories that
   * spawn a scene object per use. The merged scene path calls each factory once
   * (identity transform); the instancing path calls it per placement, reusing the
   * same geometry/material so a block is uploaded to the GPU only once.
   */
  private bucketToParts(bk: Bucket): Array<(matrix: THREE.Matrix4) => THREE.Object3D> {
    const parts: Array<(matrix: THREE.Matrix4) => THREE.Object3D> = [];

    if (bk.segPositions.length) {
      const geom = new LineSegmentsGeometry();
      geom.setPositions(new Float32Array(bk.segPositions));
      geom.setColors(new Float32Array(bk.segColors));
      const mat = new LineMaterial({
        linewidth: this.lineWidth,
        vertexColors: true,
        worldUnits: false,
        dashed: false,
      });
      this.materials.push(mat);
      this.sceneDisposables.push(geom);
      // Compute line distances and bounds once on the shared geometry.
      new LineSegments2(geom, mat).computeLineDistances();
      geom.computeBoundingSphere();
      geom.computeBoundingBox();
      parts.push((matrix) => placed(new LineSegments2(geom, mat), matrix));
    }

    if (bk.triPositions.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(bk.triPositions, 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(bk.triColors, 3));
      geom.computeBoundingSphere();
      geom.computeBoundingBox();
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.sceneDisposables.push(geom, mat);
      parts.push((matrix) => placed(new THREE.Mesh(geom, mat), matrix));
    }

    if (bk.pointPositions.length) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(bk.pointPositions, 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(bk.pointColors, 3));
      geom.computeBoundingSphere();
      geom.computeBoundingBox();
      const mat = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true });
      this.sceneDisposables.push(geom, mat);
      parts.push((matrix) => placed(new THREE.Points(geom, mat), matrix));
    }

    return parts;
  }

  /** Tessellate a block definition once into shareable per-layer geometry. */
  private buildBlockParts(def: BlockDef): BlockLayerParts[] {
    const buckets = new Map<string, Bucket>();
    for (const e of def.entities) {
      // Definitions hold only flattened geometry (no nested instances, no text).
      if (e.type === 'instance' || e.type === 'text') continue;
      // Block-local coordinates (no rebasing offset — the placement matrix carries it).
      let bk = buckets.get(e.layer);
      if (!bk) buckets.set(e.layer, (bk = emptyBucket()));
      this.appendEntity(e, bk, ZERO);
    }
    const parts: BlockLayerParts[] = [];
    for (const [layer, bk] of buckets) {
      for (const build of this.bucketToParts(bk)) parts.push({ layer, build });
    }
    return parts;
  }

  /** Fill a Matrix4 from a 2D affine, applying the rebasing offset to translation. */
  private affineToMatrix(t: Affine, out: THREE.Matrix4): THREE.Matrix4 {
    const [a, b, c, d, e, f] = t;
    // prettier-ignore
    out.set(
      a, c, 0, e - this.offset.x,
      b, d, 0, f - this.offset.y,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    return out;
  }

  private appendEntity(e: SceneEntity, bk: Bucket, offset: Vec2): void {
    if (e.type === 'instance' || e.type === 'text') return; // handled in dedicated passes
    const r = e.color.r / 255;
    const g = e.color.g / 255;
    const bl = e.color.b / 255;

    const toWorld = (p: Vec2): Vec2 => {
      const w = apply(e.transform, p);
      return { x: w.x - offset.x, y: w.y - offset.y };
    };

    const pushPolyline = (pts: Vec2[], closed: boolean) => {
      if (pts.length < 2) return;
      const w = pts.map(toWorld);
      const n = closed ? w.length : w.length - 1;
      for (let i = 0; i < n; i++) {
        const a = w[i]!;
        const c = w[(i + 1) % w.length]!;
        bk.segPositions.push(a.x, a.y, 0, c.x, c.y, 0);
        bk.segColors.push(r, g, bl, r, g, bl);
      }
    };

    switch (e.type) {
      case 'polyline':
        pushPolyline(tessellatePolyline(e.vertices, e.closed), e.closed);
        break;
      case 'arc': {
        const pts = tessellateArc(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle);
        const isFull = Math.abs(Math.abs(e.endAngle - e.startAngle) - Math.PI * 2) < 1e-6;
        pushPolyline(pts, isFull);
        break;
      }
      case 'ellipse':
        pushPolyline(
          tessellateEllipse(
            e.center.x,
            e.center.y,
            e.majorAxis.x,
            e.majorAxis.y,
            e.axisRatio,
            e.startAngle,
            e.endAngle,
          ),
          false,
        );
        break;
      case 'spline':
        pushPolyline(
          tessellateSpline(e.degree, e.controlPoints, e.knots, e.closed, e.fitPoints, e.weights),
          false,
        );
        break;
      case 'solid': {
        const w = e.points.map(toWorld);
        if (w.length >= 3) {
          // Fan-triangulate the (convex) ring.
          for (let i = 1; i < w.length - 1; i++) {
            bk.triPositions.push(w[0]!.x, w[0]!.y, 0, w[i]!.x, w[i]!.y, 0, w[i + 1]!.x, w[i + 1]!.y, 0);
            bk.triColors.push(r, g, bl, r, g, bl, r, g, bl);
          }
        }
        break;
      }
      case 'point': {
        const p = toWorld(e.position);
        bk.pointPositions.push(p.x, p.y, 0);
        bk.pointColors.push(r, g, bl);
        break;
      }
    }
  }

  /**
   * Build a troika `Text` mesh for a TEXT/MTEXT entity and add it to its layer
   * group. SHX fonts aren't embedded in DXF, so glyphs are substituted with the
   * bundled font (plan §3). Sizing/placement run on the f64 model (height,
   * position, rotation, INSERT/OCS transform), rebased by `offset` like every
   * other primitive; only the final f32 vertices reach the GPU.
   */
  private appendText(e: TextEntity, layerColor: Map<string, Layer>): void {
    const content = decodeText(e.text, e.isMText);
    if (!content.trim()) return;

    const world = apply(e.transform, e.position);
    const { rotation, scaleX, scaleY } = decompose(e.transform);

    const t = new TroikaText();
    if (this.fontUrl) t.font = this.fontUrl;
    t.text = content;
    // DXF height is cap height; troika fontSize is the em box (see CAP_HEIGHT_RATIO).
    t.fontSize = (e.height * scaleY) / CAP_HEIGHT_RATIO;
    t.color = (e.color.r << 16) | (e.color.g << 8) | e.color.b;
    t.anchorX = anchorX(e.hAlign);
    t.anchorY = anchorY(e.vAlign);
    t.textAlign = e.hAlign;
    // MTEXT reference rectangle width drives wrapping; 0 means no wrap.
    if (e.isMText && e.width > 0) t.maxWidth = e.width * scaleX;
    t.position.set(world.x - this.offset.x, world.y - this.offset.y, 0);
    t.rotation.z = e.rotation + rotation;
    // Draw text above fills/lines sharing z=0 to avoid the orthographic tie.
    t.renderOrder = 1;

    this.layerGroup(e.layer, layerColor).add(t);
    this.textObjects.push(t);
    // Layout/SDF generation is async; repaint once it completes.
    t.sync(() => this.requestRender());
  }

  /**
   * Layer group for `name`, creating it if no batched geometry produced one
   * (a layer can hold only text). Mirrors the visibility rule used for buckets.
   */
  private layerGroup(name: string, layerColor: Map<string, Layer>): THREE.Group {
    const existing = this.layers.get(name);
    if (existing) return existing.group;
    const group = new THREE.Group();
    group.name = name;
    const layer = layerColor.get(name);
    group.visible = layer ? layer.visible && !layer.frozen : true;
    this.scene.add(group);
    this.layers.set(name, { group });
    return group;
  }

  /**
   * Contribute an entity's snap geometry to the builder, in true world float64
   * coordinates (no rebasing offset) so measurements read exact values. Stored
   * snaps are the meaningful object points (endpoints, midpoints, centers);
   * tessellated segments back nearest-point and intersection snaps.
   */
  private addEntitySnap(e: SceneEntity, snap: SnapBuilder): void {
    const tw = (p: Vec2): Vec2 => apply(e.transform, p);
    const addSegments = (worldPts: Vec2[]): void => {
      for (let i = 0; i < worldPts.length - 1; i++) {
        const a = worldPts[i]!;
        const b = worldPts[i + 1]!;
        snap.addSegment(a.x, a.y, b.x, b.y);
      }
    };

    switch (e.type) {
      case 'polyline': {
        const verts = e.vertices.map((v) => tw(v));
        for (const v of verts) snap.addPoint(v.x, v.y, 'endpoint');
        const spanCount = e.closed ? verts.length : verts.length - 1;
        for (let i = 0; i < spanCount; i++) {
          const a = verts[i]!;
          const b = verts[(i + 1) % verts.length]!;
          snap.addPoint((a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint');
        }
        addSegments(tessellatePolyline(e.vertices, e.closed).map(tw));
        break;
      }
      case 'arc': {
        const c = tw(e.center);
        snap.addPoint(c.x, c.y, 'center');
        let span = e.endAngle - e.startAngle;
        if (span <= 0) span += Math.PI * 2;
        const isFull = Math.abs(span - Math.PI * 2) < 1e-6;
        const at = (angle: number): Vec2 =>
          tw({ x: e.center.x + e.radius * Math.cos(angle), y: e.center.y + e.radius * Math.sin(angle) });
        if (!isFull) {
          const start = at(e.startAngle);
          const end = at(e.startAngle + span);
          snap.addPoint(start.x, start.y, 'endpoint');
          snap.addPoint(end.x, end.y, 'endpoint');
        }
        const mid = at(e.startAngle + span / 2);
        snap.addPoint(mid.x, mid.y, 'midpoint');
        addSegments(
          tessellateArc(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle).map(tw),
        );
        break;
      }
      case 'ellipse': {
        const c = tw(e.center);
        snap.addPoint(c.x, c.y, 'center');
        const pts = tessellateEllipse(
          e.center.x,
          e.center.y,
          e.majorAxis.x,
          e.majorAxis.y,
          e.axisRatio,
          e.startAngle,
          e.endAngle,
        ).map(tw);
        if (pts.length) {
          snap.addPoint(pts[0]!.x, pts[0]!.y, 'endpoint');
          snap.addPoint(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, 'endpoint');
        }
        addSegments(pts);
        break;
      }
      case 'spline': {
        const pts = tessellateSpline(
          e.degree,
          e.controlPoints,
          e.knots,
          e.closed,
          e.fitPoints,
          e.weights,
        ).map(tw);
        if (pts.length) {
          snap.addPoint(pts[0]!.x, pts[0]!.y, 'endpoint');
          snap.addPoint(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y, 'endpoint');
        }
        addSegments(pts);
        break;
      }
      case 'solid': {
        const ring = e.points.map(tw);
        for (const v of ring) snap.addPoint(v.x, v.y, 'endpoint');
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!;
          const b = ring[(i + 1) % ring.length]!;
          snap.addPoint((a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint');
          snap.addSegment(a.x, a.y, b.x, b.y);
        }
        break;
      }
      case 'point': {
        const p = tw(e.position);
        snap.addPoint(p.x, p.y, 'endpoint');
        break;
      }
      case 'text':
        break;
    }
  }

  /**
   * Contribute snap geometry for an instanced block by composing each block-local
   * leaf with the placement transform and reusing the per-entity snap logic. Snaps
   * are stored in true world float64 (no rebasing offset), like every other entity.
   */
  private addInstanceSnap(inst: InstanceEntity, scene: Scene, snap: SnapBuilder): void {
    const def = scene.blocks[inst.block];
    if (!def) return;
    for (const leaf of def.entities) {
      if (leaf.type === 'instance') continue; // definitions never nest instances
      this.addEntitySnap(
        { ...leaf, transform: multiply(inst.transform, leaf.transform) } as SceneEntity,
        snap,
      );
    }
  }

  setLayerVisible(name: string, visible: boolean): void {
    const layer = this.layers.get(name);
    if (layer) {
      layer.group.visible = visible;
      this.requestRender();
    }
  }

  /** World-space (true, offset re-added) point under a CSS-pixel screen coordinate. */
  screenToWorld(px: number, py: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const x = this.center.x + (px - rect.width / 2) / this.scale;
    const y = this.center.y - (py - rect.height / 2) / this.scale;
    return { x: x + this.offset.x, y: y + this.offset.y };
  }

  /** CSS-pixel screen coordinate for a true world-space point (inverse of `screenToWorld`). */
  worldToScreen(world: Vec2): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const localX = world.x - this.offset.x - this.center.x;
    const localY = world.y - this.offset.y - this.center.y;
    return {
      x: rect.width / 2 + localX * this.scale,
      y: rect.height / 2 - localY * this.scale,
    };
  }

  /** Current zoom in CSS pixels per world unit (for converting pixel tolerances). */
  get pixelsPerUnit(): number {
    return this.scale;
  }

  /**
   * Best object snap near a true world-space point, or null. `pixelRadius` is
   * the screen-space tolerance; it is converted to world units via the current
   * zoom so the catch radius stays constant on screen. Runs on the float64 snap
   * geometry (plan §5).
   */
  querySnap(world: Vec2, pixelRadius: number): SnapResult | null {
    if (!this.snapIndex || this.snapIndex.isEmpty) return null;
    return this.snapIndex.query(world, pixelRadius / this.scale);
  }

  /** Subscribe to camera changes (pan/zoom/fit/resize). Returns an unsubscribe fn. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /**
   * When false, the left mouse button no longer pans — it is left free for an
   * active tool (e.g. measuring) to handle clicks. Middle-button drag still pans.
   */
  setPanWithLeftButton(enabled: boolean): void {
    this.panLeftButton = enabled;
  }

  fitToView(scene?: Scene): void {
    const parsed = scene ?? this.currentScene ?? undefined;
    const rect = this.canvas.getBoundingClientRect();
    let w = 1;
    let h = 1;
    let cx = 0;
    let cy = 0;
    if (parsed?.bounds.valid) {
      w = Math.max(parsed.bounds.max.x - parsed.bounds.min.x, 1e-6);
      h = Math.max(parsed.bounds.max.y - parsed.bounds.min.y, 1e-6);
      cx = (parsed.bounds.min.x + parsed.bounds.max.x) / 2 - this.offset.x;
      cy = (parsed.bounds.min.y + parsed.bounds.max.y) / 2 - this.offset.y;
    }
    const margin = 1.1;
    const scaleX = rect.width / (w * margin);
    const scaleY = rect.height / (h * margin);
    this.scale = Math.min(scaleX, scaleY) || 1;
    this.center = { x: cx, y: cy };
    this.updateCamera();
    this.requestRender();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.updateCamera();
    this.updateMaterialResolution();
    this.requestRender();
  }

  private updateCamera(): void {
    const rect = this.canvas.getBoundingClientRect();
    const halfW = rect.width / 2 / this.scale;
    const halfH = rect.height / 2 / this.scale;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.position.x = this.center.x;
    this.camera.position.y = this.center.y;
    this.camera.updateProjectionMatrix();
    for (const cb of this.changeListeners) cb();
  }

  private updateMaterialResolution(): void {
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    for (const m of this.materials) m.resolution.set(w, h);
  }

  private attachControls(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (ev: PointerEvent) => {
      // Left button pans only when not reserved for a tool; middle always pans.
      if (ev.button === 0 && !this.panLeftButton) return;
      if (ev.button !== 0 && ev.button !== 1) return;
      dragging = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      this.canvas.setPointerCapture(ev.pointerId);
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      this.center.x -= dx / this.scale;
      this.center.y += dy / this.scale;
      this.updateCamera();
      this.requestRender();
    };
    const onPointerUp = (ev: PointerEvent) => {
      dragging = false;
      if (this.canvas.hasPointerCapture(ev.pointerId)) this.canvas.releasePointerCapture(ev.pointerId);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const before = this.screenToWorld(px, py);
      const factor = Math.exp(-ev.deltaY * 0.0015);
      this.scale *= factor;
      // Keep the world point under the cursor fixed.
      const after = this.screenToWorld(px, py);
      this.center.x += before.x - after.x;
      this.center.y += before.y - after.y;
      this.updateCamera();
      this.requestRender();
    };

    this.canvas.addEventListener('pointerdown', onPointerDown);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointerup', onPointerUp);
    this.canvas.addEventListener('wheel', onWheel, { passive: false });
    this.disposers.push(() => {
      this.canvas.removeEventListener('pointerdown', onPointerDown);
      this.canvas.removeEventListener('pointermove', onPointerMove);
      this.canvas.removeEventListener('pointerup', onPointerUp);
      this.canvas.removeEventListener('wheel', onWheel);
    });
  }

  private requestRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  private clearScene(): void {
    for (const t of this.textObjects) {
      t.parent?.remove(t);
      t.dispose();
    }
    this.textObjects.length = 0;
    for (const { group } of this.layers.values()) this.scene.remove(group);
    this.layers.clear();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    // Geometries/materials are shared across instanced placements, so dispose them
    // once from the tracked list rather than by traversing (which double-frees).
    for (const d of this.sceneDisposables) d.dispose();
    this.sceneDisposables.length = 0;
  }

  dispose(): void {
    this.clearScene();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.renderer.dispose();
  }
}
