# DWG/DXF Viewer

A read-only, browser-based CAD viewer. This repository implements the **Phase 1
DXF viewer MVP** and **Phase 2 measurement** from
[`docs/plans/web-dwg-dxf-viewer.md`](docs/plans/web-dwg-dxf-viewer.md): open a
DXF, see it rendered correctly, navigate it (pan/zoom + layer toggles), and
measure it (distance, area, angle) with object snapping. Data stays on the
device — parsing, rendering and measurement are entirely client-side.

## Quick start

```bash
pnpm install
pnpm dev          # Astro dev server (apps/web)
pnpm build        # production build of the web app + library packages
pnpm test         # unit tests (vitest)
pnpm typecheck    # tsc across all packages
```

Then open the app, click **Open DXF** (or drag a `.dxf` onto the canvas).

## Monorepo layout

```
apps/web            Astro shell; mounts the viewer as a client:only React island
packages/dxf-core   DXF → normalized, framework-agnostic float64 scene model
packages/viewer-engine  three.js renderer: tessellation, rebasing, pan/zoom, layers
packages/viewer-react   React island wrapping the engine + toolbar + layer panel + measurement overlay
packages/measure        snapping (R-tree) + distance/area/angle math + unit-aware formatting
```

The packages are **internal/source-consumed**: their `exports` point at TypeScript
source, so Vite/Astro transpiles them on the fly with no build step during dev.
`pnpm build` still produces `dist/` (tsdown) for standalone consumption.

`dxf-core` and `viewer-engine` are pure TypeScript with no framework dependency,
so they stay testable in isolation; `viewer-react` is the only package that
touches React.

## How it works

1. **`dxf-core`** parses DXF text and produces a normalized scene model. Curves
   (arcs, ellipses, splines, polyline bulges) stay **parametric** — the engine
   owns tessellation. Each entity carries a 2D affine transform into which block
   INSERT placement (nesting, non-uniform/mirrored scale, MINSERT arrays) and OCS
   extrusion correction are baked. Colors are resolved through ByLayer/ByBlock/ACI;
   `$INSUNITS` sets the drawing units.
2. **`viewer-engine`** tessellates curves, rebases coordinates to a local origin
   (precision strategy below), batches geometry per layer into fat-line
   (`LineSegments2`) / mesh / point objects, and drives an orthographic camera
   with custom pan/zoom.
3. **`measure`** builds an R-tree (`flatbush`) over the scene's snap points
   (endpoints, midpoints, centers) and segments, and provides the distance /
   area / angle math and unit-aware formatting. All of it runs on the float64
   world model, never on f32 GPU coordinates.
4. **`viewer-react`** + **`apps/web`** provide the file-open flow, layer panel,
   toolbar (entity count, units, live world-coordinate readout), measurement
   tools with an SVG annotation overlay, and Zustand state.

### Measurement (plan §4)

Pick **Distance**, **Area**, or **Angle** in the toolbar, then click points on
the drawing; an SVG overlay draws the annotation and the live value:

- **Snapping** — the cursor snaps to the nearest endpoint, midpoint, center,
  intersection, or point-on-edge within a fixed pixel tolerance, shown by a
  marker. Intersections are computed lazily from the few segments near the
  cursor (never precomputed all-pairs).
- **Distance** is cumulative (click a polyline; total updates live).
  **Area** reports area and perimeter of the closed polygon. **Angle** is the
  included angle at the middle of three clicked points.
- While a tool is active the left button places points (middle-drag still pans);
  double-click or **Enter** finishes, **Esc** cancels. Measured values use the
  drawing's `$INSUNITS`, so distances read in real units.

### Precision (plan §5)

CAD drawings often carry large absolute coordinates (survey coords in the
millions), which jitter under WebGL's 32-bit floats. The scene model is kept in
float64; on load the engine rebases to a local origin and pushes only f32 to the
GPU. `screenToWorld()` re-adds the offset, so any downstream measurement runs
against true f64 world coordinates.

## Key decision: DXF parser license

The plan preferred `@dxfom/dxf`, but that package is **GPL-3.0** — it would impose
copyleft on a shipped frontend bundle, which the plan's own licensing analysis (§1)
cares about. We use **`dxf-parser` (MIT)** instead, isolated behind an adapter
(`packages/dxf-core/src/adapter.ts`) so the parser remains swappable if a Phase 0
spike against real drawings favors something else.

## Supported entities

LINE, LWPOLYLINE, POLYLINE (with bulges), CIRCLE, ARC, ELLIPSE, SPLINE (NURBS via
de Boor), POINT, SOLID/3DFACE, INSERT (nested, arrays), DIMENSION (renders its
anonymous block). TEXT/MTEXT are parsed and retained in the model but **not yet
rendered** (see below).

## Not yet implemented (deferred)

- **Text rendering.** TEXT/MTEXT are parsed but not drawn; SHX→TrueType
  substitution (SDF/atlas) is the Phase 0/2 text spike. Text is often the bulk of
  entities and the top fidelity complaint — budgeted, not done.
- **Lineweights & dashed linetypes.** Lines render at a constant crisp pixel width
  via `LineSegments2`; per-entity lineweight (mm) and linetype dashing are carried
  in the model but not yet applied.
- **Adaptive tessellation.** Curves use a fixed relative chord tolerance; they will
  facet when zoomed far in. Re-tessellation on zoom is a later refinement.
- **DWG input** (Phase 3), **paper-space layouts**, **pattern hatches**,
  **true-color (DXF 420)** entities (fall back to layer color).
- **Snapping refinements** — snap geometry currently includes all loaded
  entities (hidden layers included) and uses chord-midpoints for bulge arcs;
  per-layer filtering and true arc midpoints are later refinements.
- **Instanced blocks.** INSERTs are flattened (correct, simple); `InstancedMesh`
  is a Phase 4 performance optimization.
```
