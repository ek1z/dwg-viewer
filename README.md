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

### Printing a region

Pick **Print** in the toolbar, then click two opposite corners to mark a
rectangular area (a rubber-band rectangle previews while you drag toward the
cursor; **Esc** cancels). A small panel lets you choose the paper size (A4 / A3 /
Letter) and a white or dark page background; orientation follows the region's
aspect and an approximate scale (`≈ 1:100`, shown when the drawing has real
units) is computed for the fit-to-page output. **Print / Save as PDF** rasterizes
just that region — through a dedicated off-screen renderer, so the live view is
untouched — and opens the browser's print dialog, where "Save as PDF" is the
standard destination. Everything stays on-device.

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
anonymous block), HATCH (solid fills and line patterns — see below), TEXT/MTEXT
(SDF text via font substitution — see below).

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

### Lineweights & dashed linetypes (plan §3)

Per-entity **lineweights** render in *display mode* (like AutoCAD's `LWDISPLAY`):
millimetre widths map to on-screen pixels at a fixed scale, **independent of
zoom**, so a thick line stays visibly thick without growing as you zoom. Because
`LineMaterial`'s width is a per-material uniform, segments are batched per
`(layer, width)` rather than per layer; DXF lineweights are a small fixed enum,
so the extra buckets are bounded. A toolbar **Lineweights** toggle flips display
on/off live (`setLineweightDisplay` swaps material uniforms — no rebuild).

**Dashed linetypes** are expanded on the CPU: each tessellated polyline is walked
and broken into dash sub-segments following the LTYPE pattern (group 49: + dash,
− gap, 0 dot), scaled by the global `$LTSCALE` and the entity's linetype scale.
This deliberately departs from the plan's "dashing via `LineMaterial`" — that only
supports a single dash/gap pair, so multi-element patterns (CENTER, DASHDOT,
PHANTOM) would lose fidelity. CPU expansion produces ordinary segments that reuse
the existing fat-line batching and block instancing untouched, and the dashes are
world-anchored (they scale correctly with zoom). A per-entity blow-up guard falls
back to a solid line when a pattern would emit excessive dashes.

Two parser gaps shaped this work. `dxf-parser` carries the LTYPE pattern table
but **drops each layer's default linetype (group 6) and lineweight (group 370)** —
which is exactly where "ByLayer" entities (the common case) keep that info. A
focused supplemental scan (`packages/dxf-core/src/layerDefaults.ts`) re-reads the
LAYER table from the raw DXF text to recover those defaults; it runs on the DXF
text so the DWG path (DWG → DXF) is covered too, and keeps `dxf-parser` unforked.

*Known limitation:* dash spacing for **scaled block instances** is computed in
block-local units once per definition, so it is approximate when an instance is
non-uniformly scaled.

### Hatches (plan §3)

HATCH entities render both **solid fills** and **line patterns**. `dxf-parser`
ships no HATCH handler (it silently drops the entity), so `dxf-core` registers
its own (`packages/dxf-core/src/hatch.ts`) and normalizes the result to a
parametric `HatchEntity` — boundary loops stay parametric (polylines with bulges,
or edge sequences of lines/arcs/ellipses/splines), exactly like every other
curved entity, and `viewer-engine` owns tessellation.

Boundaries are filled with the **even-odd rule** across all loops (the default
AutoCAD "normal" style), so nested loops cut islands automatically. Solid fills
triangulate to a mesh; line patterns expand each pattern-definition line family,
clip it to the boundary with a scanline pass, and dash it through the same
machinery as dashed linetypes above. Pathological hatches are bounded by
per-family and total run caps so a malformed pattern can't exhaust memory.

## Not yet implemented (deferred)

- **Adaptive tessellation.** Curves use a fixed relative chord tolerance; they will
  facet when zoomed far in. Re-tessellation on zoom is a later refinement.
- **Paper-space layouts**, **gradient hatches** (solid + pattern hatches are
  supported; gradient fills render as a flat solid), **true-color (DXF 420)**
  entities (fall back to layer color).
- **Snapping refinements** — snap geometry currently includes all loaded
  entities (hidden layers included) and uses chord-midpoints for bulge arcs;
  per-layer filtering and true arc midpoints are later refinements.
```
