# DWG/DXF Viewer

A read-only, browser-based CAD viewer. This repository implements the **Phase 1
DXF viewer MVP**, **Phase 2 measurement**, and **Phase 3 DWG input** from
[`docs/plans/web-dwg-dxf-viewer.md`](docs/plans/web-dwg-dxf-viewer.md): open a
DXF **or DWG**, see it rendered correctly, navigate it (pan/zoom + layer
toggles), and measure it (distance, area, angle) with object snapping. Data
stays on the device — conversion, parsing, rendering and measurement are
entirely client-side.

## Quick start

```bash
pnpm install
pnpm dev          # Astro dev server (apps/web)
pnpm build        # production build of the web app + library packages
pnpm test         # unit tests (vitest)
pnpm typecheck    # tsc across all packages
```

Then open the app, click **Open** (or drag a `.dxf`/`.dwg` onto the canvas).

## Monorepo layout

```
apps/web            Astro shell; mounts the viewer as a client:only React island
packages/dxf-core   DXF → normalized, framework-agnostic float64 scene model
packages/dwg-core   DWG → DXF (libredwg WASM) → dxf-core scene model
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
   extrusion correction are baked. Frequently-repeated blocks are instead kept as
   shared, instanced definitions (see *Block instancing* below). Colors are resolved
   through ByLayer/ByBlock/ACI; `$INSUNITS` sets the drawing units.
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

### DWG input (plan §4, Phase 3)

`.dwg` files are handled by **`dwg-core`**, which converts the drawing to DXF
in-browser with the [`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web)
WASM build of LibreDWG, then feeds the result through the exact same `parseDxf`
pipeline as native DXF. Nothing downstream of the parse step knows or cares which
format the file started as — the scene model, rendering, snapping and measurement
are identical either way (the plan's "everything downstream consumes the
normalized model"). The ~7 MB WASM module is dynamically imported and loaded once
on first DWG open, so DXF-only sessions never download it.

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

### Block instancing (plan §5 — performance)

Drawings often place the same block (a symbol, fixture, tree, title-block detail)
hundreds or thousands of times. Flattening every placement duplicates its geometry
in CPU and GPU memory and re-tessellates it once per copy. Instead, `dxf-core`
keeps a block that repeats **≥ 4 times** as a lightweight `InstanceEntity` — just a
block index plus the placement's local→world affine — pointing at a shared entry in
`scene.blocks`. The engine tessellates each block definition **once** into shared
GPU buffers and draws each placement as a thin scene object that reuses those
buffers, so memory is **O(unique blocks)** rather than **O(placements)**, and each
placement is **frustum-culled** independently — off-screen copies cost nothing to
draw. A single MINSERT grid expands to one instance per cell over the same shared
definition.

Definitions are keyed by `(block, resolved layer + colour)`, so ByBlock colour and
layer-"0" inheritance — which depend on the enclosing INSERT — stay correct while
still sharing across placements with the same context. Blocks below the threshold,
and any block containing **TEXT/MTEXT or DIMENSION** (text renders as separate SDF
meshes; dimensions carry anonymous sub-blocks), fall back to the flatten-and-merge
path, so rendering, snapping and measurement are identical either way. Only
top-level INSERTs instance; nested blocks flatten into their parent definition
(which is itself shared once). The toolbar's entity count reports expanded leaf
geometry (`scene.entityCount`), not the collapsed instance count.

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

The **DWG** path is a different story: `@mlightcad/libredwg-web` is **GPL-3.0**, so
shipping it imposes copyleft on the bundle. Per the plan's §1 analysis this is
**option A** — fine for an internal tool, the risk to revisit before distributing
externally. It is isolated in its own `dwg-core` package and dynamically imported,
so it only ships if you build with DWG support; `dxf-core` stays MIT-only. The
alternative (option B — a server-side `dwg2dxf` so GPL stays out of the frontend)
remains open without touching anything downstream of the parse step.

## Supported entities

LINE, LWPOLYLINE, POLYLINE (with bulges), CIRCLE, ARC, ELLIPSE, SPLINE (NURBS via
de Boor), POINT, SOLID/3DFACE, INSERT (nested, arrays), DIMENSION (renders its
anonymous block), TEXT/MTEXT (SDF text via font substitution — see below).

### Text rendering (plan §3, Phase 4)

TEXT/MTEXT are rendered as **SDF geometry** with [`troika-three-text`](https://github.com/protectwise/troika).
SHX fonts aren't embedded in DXF, so glyphs are **substituted** with a bundled
TrueType font — **Liberation Sans** (SIL OFL 1.1, metric-compatible with Arial),
self-hosted at `apps/web/public/fonts` so nothing is fetched from a CDN and both
drawing data and rendering stay on-device. SDF keeps text crisp at any zoom,
which matters because text is sized in **world units** and scales with the
drawing.

Sizing and placement run on the float64 model exactly like every other
primitive: DXF `height` (cap height) maps to troika's em-box `fontSize` via a
cap-height ratio, the entity's INSERT/OCS transform is decomposed into rotation +
scale, alignment maps to cap/baseline-relative anchors, and MTEXT reference-width
wrapping is honored. MTEXT inline formatting (`\P`, font/height/color runs,
stacked fractions, `\U+XXXX`, brace groups) and DTEXT `%%`-codes (`%%d`→°,
`%%c`→⌀, `%%p`→±) are decoded to plain text (`packages/viewer-engine/src/text.ts`,
unit-tested); styling runs are dropped — content fidelity, not style fidelity.
Substitution means it won't be pixel-perfect against the original SHX, as the
plan calls out.

## Not yet implemented (deferred)

- **Lineweights & dashed linetypes.** Lines render at a constant crisp pixel width
  via `LineSegments2`; per-entity lineweight (mm) and linetype dashing are carried
  in the model but not yet applied.
- **Adaptive tessellation.** Curves use a fixed relative chord tolerance; they will
  facet when zoomed far in. Re-tessellation on zoom is a later refinement.
- **Paper-space layouts**, **pattern hatches**, **true-color (DXF 420)**
  entities (fall back to layer color).
- **Snapping refinements** — snap geometry currently includes all loaded
  entities (hidden layers included) and uses chord-midpoints for bulge arcs;
  per-layer filtering and true arc midpoints are later refinements.
```
