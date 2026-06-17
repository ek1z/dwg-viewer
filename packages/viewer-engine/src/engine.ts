import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { apply, type Scene, type SceneEntity, type Vec2 } from '@dwg-viewer/dxf-core';
import { tessellateArc, tessellateEllipse, tessellatePolyline, tessellateSpline } from './tessellate.js';

export interface ViewerOptions {
  /** Background color (hex). Default dark CAD grey. */
  background?: number;
  /** Constant on-screen line width in CSS pixels. */
  lineWidth?: number;
}

interface LayerObjects {
  group: THREE.Group;
}

const DEFAULT_BG = 0x1e1e1e;
const DEFAULT_LINE_WIDTH = 1.4;

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

  /** Rebasing offset: worldLocal = world − offset. */
  private offset: Vec2 = { x: 0, y: 0 };
  /** Most recently loaded scene, retained so `fitToView()` can reframe. */
  private currentScene: Scene | null = null;
  /** World-local point currently at screen center. */
  private center: Vec2 = { x: 0, y: 0 };
  /** CSS pixels per world unit. */
  private scale = 1;

  private renderScheduled = false;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: ViewerOptions = {},
  ) {
    this.lineWidth = options.lineWidth ?? DEFAULT_LINE_WIDTH;
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

    type Bucket = {
      segPositions: number[];
      segColors: number[];
      triPositions: number[];
      triColors: number[];
      pointPositions: number[];
      pointColors: number[];
    };
    const buckets = new Map<string, Bucket>();
    const bucketFor = (layer: string): Bucket => {
      let bk = buckets.get(layer);
      if (!bk) {
        bk = {
          segPositions: [],
          segColors: [],
          triPositions: [],
          triColors: [],
          pointPositions: [],
          pointColors: [],
        };
        buckets.set(layer, bk);
      }
      return bk;
    };

    for (const e of parsed.entities) {
      this.appendEntity(e, bucketFor(e.layer));
    }

    for (const [layerName, bk] of buckets) {
      const group = new THREE.Group();
      group.name = layerName;

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
        const seg = new LineSegments2(geom, mat);
        seg.computeLineDistances();
        group.add(seg);
      }

      if (bk.triPositions.length) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(bk.triPositions, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(bk.triColors, 3));
        const mesh = new THREE.Mesh(
          geom,
          new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
        );
        group.add(mesh);
      }

      if (bk.pointPositions.length) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(bk.pointPositions, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(bk.pointColors, 3));
        const pts = new THREE.Points(
          geom,
          new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true }),
        );
        group.add(pts);
      }

      const layer = layerColor.get(layerName);
      group.visible = layer ? layer.visible && !layer.frozen : true;
      this.scene.add(group);
      this.layers.set(layerName, { group });
    }

    this.fitToView(parsed);
    this.updateMaterialResolution();
    this.requestRender();
  }

  private appendEntity(
    e: SceneEntity,
    bk: {
      segPositions: number[];
      segColors: number[];
      triPositions: number[];
      triColors: number[];
      pointPositions: number[];
      pointColors: number[];
    },
  ): void {
    const r = e.color.r / 255;
    const g = e.color.g / 255;
    const bl = e.color.b / 255;

    const toWorld = (p: Vec2): Vec2 => {
      const w = apply(e.transform, p);
      return { x: w.x - this.offset.x, y: w.y - this.offset.y };
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
      case 'text':
        // Text rendering (SDF/atlas substitution for SHX) is deferred; the
        // entity is retained in the scene model for a later text pass.
        break;
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
    for (const { group } of this.layers.values()) {
      this.scene.remove(group);
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
          obj.geometry.dispose();
        }
      });
    }
    this.layers.clear();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }

  dispose(): void {
    this.clearScene();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.renderer.dispose();
  }
}
