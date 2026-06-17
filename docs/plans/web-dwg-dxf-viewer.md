# Web-Based DWG/DXF Viewer — Build Plan

A read-only CAD viewer with interactive measurement (distance, area, angle), built on a pnpm + Astro stack. Data stays on-prem.

---

## 1. Scope & key decisions

**In scope:** open a drawing, pan/zoom, toggle layers, snap to points, measure. **Out of scope:** any editing or writing files back out (this is what kept the build cheap — no ODA license, no DWG write path).

Two architecture options, decided by *internal tool vs. shipped product*:

| | **A — Fully client-side** | **B — On-prem conversion service** |
|---|---|---|
| DWG handling | `libredwg-web` (WASM) parses DWG in the browser | Node service shells out to LibreDWG `dwg2dxf`; browser only ever sees DXF |
| Data exposure | File never leaves the device — best privacy | File touches a server you control (still on-prem) |
| Licensing | Ships GPLv3 WASM → your bundle inherits GPL concerns. **Fine for internal use, risky if distributed externally** | GPL stays server-side as a separate process (mere-aggregation argument); frontend ships only open DXF tooling |
| Bundle | Large WASM payload | Light frontend |

**Recommendation:** Start with **DXF-only** for the MVP (sidesteps the whole DWG question), then add DWG via **A if internal, B if shipped.** Measurement and rendering are identical either way.

---

## 2. Monorepo layout (pnpm workspace)

```
dwg-viewer/
├── pnpm-workspace.yaml
├── apps/
│   └── web/                 # Astro app: shell, routing, file-open UI, layout, i18n
├── packages/
│   ├── dxf-core/            # parse DXF → normalized, framework-agnostic scene model
│   ├── viewer-engine/       # WebGL renderer (three.js), camera, pan/zoom, layers
│   ├── measure/             # snapping + measurement tools, unit handling
│   └── viewer-react/        # React island wrapping engine + measure + tool UI
└── services/
    └── dwg-convert/         # OPTIONAL (option B): containerized Node + libredwg binary
```

Rationale: the engine and measure logic are pure TS with no framework dependency, so they stay testable in isolation and reusable (you could later wrap them for React Native too). `viewer-react` is the only package that touches React; the Astro app just mounts it.

---

## 3. Tech stack

- **pnpm workspace** — package boundaries above.
- **Astro 6** — app shell, routing, the file-open page, layout. The viewer itself is a `client:only="react"` island (all parsing/WebGL is browser-side; SSR buys nothing here). **Open question:** the whole app is effectively one `client:only` island, so Astro earns little over a plain Vite + React SPA — revisit if no genuine multi-page story emerges, and verify the intended Astro major version is actually released/stable before pinning to it.
- **TypeScript**, strict.
- **three.js** — WebGL rendering. Use an orthographic camera for true 2D; build geometry from parsed entities. **Lines need fat-line rendering** (`Line2`/`LineMaterial`): WebGL's native line primitive clamps `lineWidth` to 1px on virtually all platforms, so lineweights and dashed linetypes require triangle-based line geometry — which interacts directly with the large-entity performance target (see §5).
- **DXF parsing** — `@dxfom/*` preferred, with `dxf-parser` as the fallback; evaluate both in the Phase 0 spike against real files. (`dxf-parser` is less actively maintained, with known gaps around MTEXT and splines.) Note that parsers emit arcs/ellipses/splines/bulge polylines as math, not segments — `viewer-engine` owns curve tessellation (see Phase 1).
- **DWG parsing (later)** — `@mlightcad/libredwg-web` (option A) or LibreDWG `dwg2dxf` CLI (option B).
- **Spatial index for snapping** — `flatbush` or `rbush` (R-tree) over entity endpoints/midpoints/intersections.
- **State** — Zustand for viewer + active-tool + measurement state.
- **Styling** — StyleX. (Adds a compiler/Babel step; reasonable if it's the house style, heavyweight for a tool this size otherwise.)
- **Text rendering** — TrueType substitution via an SDF text approach (e.g. `troika-three-text` or a glyph atlas). SHX fonts are *not* embedded in the file and won't be pixel-perfect — plan for font substitution rather than fidelity.
- **Library builds** — tsdown for the `packages/*` builds.
- **Testing** — Vitest (unit), Playwright (E2E in-browser).

---

## 4. Phases & milestones

**Phase 0 — Spikes / derisking (~1 week).** Collect a corpus of *real* drawings from actual users (and treat that corpus as customer data — store it accordingly). Run candidate DXF parsers + viewer libraries against them. Confirm two layers of fidelity:
- *Parsing:* layers, blocks/INSERTs, line types, hatches, text, dimension entities, and model-vs-paper-space layouts all come through.
- *Rendering (the part plans usually skip):* spike **fat-line rendering** (lineweights + dashed linetypes via `Line2`) and **text rendering** (TrueType substitution for SHX) early — these constrain the whole rendering architecture and are the most common real-world fidelity complaints. Decide hatch scope here too (solid fills are easy; pattern hatches with island/boundary nesting are custom, hard work — scope out of MVP unless the corpus demands them).

This is the single most important phase — fidelity problems found here are cheap; found in Phase 3 they're expensive.

**Phase 1 — DXF viewer MVP (~2–3 weeks).** `dxf-core` produces a normalized scene model; `viewer-engine` renders it in three.js with smooth pan/zoom and a layer panel (show/hide). Astro app gets a file-open flow. Deliverable: open a DXF, see it correctly, navigate it. Key work the "renders it" line hides:
- **Curve tessellation** — convert arcs/ellipses/splines/bulge polylines to segments, adaptively (a spline tessellated for a zoomed-out view goes faceted on zoom-in).
- **OCS / extrusion direction** (DXF codes 210/220/230) — 2D entities can carry an arbitrary Object Coordinate System; ignoring it silently mirrors or misplaces geometry. Classic "drawing is backwards" bug.
- **Blocks/INSERTs** — handle nested INSERTs, non-uniform and negative (mirroring) scale, and MINSERT arrays. This is where `InstancedMesh` pays off.
- **Color/layer resolution** — ByLayer/ByBlock resolution, ACI color index + true color, and layer freeze vs. off (not just show/hide).
- **Scope to model space only** for the MVP. Paper-space layouts with viewport entities (clipped, scaled views into model space) are a Phase 4 concern.

**Phase 2 — Measurement (~2 weeks).** The differentiator, and it's custom work:
- Screen ↔ world coordinate transform. **All measurement math runs on the float64 scene model + stored rebasing offset (see §5), never on screen-projected f32 GPU positions** — otherwise the precision fix is undone at the measurement step.
- Object snapping (endpoint, midpoint, intersection, nearest) via the spatial index, with a visual snap marker. Index endpoints/midpoints/centers in the R-tree; compute **intersections lazily** for candidates near the cursor (all-pairs intersection is O(n²) and must not be precomputed). Snap tolerance is a pixel radius converted to world units via current zoom.
- Unit handling — read `$INSUNITS` / `$MEASUREMENT` from the DXF header and apply the scale factor so distances read in real units.
- Tools: point-to-point distance first, then cumulative/polyline, area, and angle.
- Annotations drawn on an overlay layer above the scene.

**Phase 3 — DWG input (~1–2 weeks).** Wire in the chosen conversion path (A or B). The rest of the app is untouched because everything downstream consumes the normalized model.

**Phase 4 — Hardening.** Large-file performance, edge cases from the corpus, keyboard/accessibility, persistence of measurement sessions if wanted.

---

## 5. Technical risks to watch

- **Parsing *and rendering* fidelity** on messy real-world files — derisk in Phase 0, never with synthetic samples only. Rendering fidelity (lines, text, hatches, OCS) is the long-tail risk, not parsing; the hard part isn't getting entities out of the file, it's drawing them faithfully.
- **Line rendering:** WebGL's native line primitive clamps width to 1px, so lineweights and dashed linetypes need fat-line (triangle) geometry via `Line2`/`LineMaterial`. This generates per-segment geometry and so collides head-on with the large-entity performance target below — spike it in Phase 0.
- **Text rendering:** SHX fonts aren't embedded; substitution to TrueType (SDF/atlas) is required and won't be pixel-perfect. Text is often the majority of entities and the top fidelity complaint — budget for it, don't assume "it parses" means "it renders."
- **Float32 precision (subtle but real):** CAD drawings often carry large absolute coordinates (survey coords in the millions); WebGL uses 32-bit floats and will visibly jitter/snap-wrong at that magnitude. Fix: keep the parsed scene model in **float64**, push only f32 to GPU buffers, rebase the scene to a local origin on load, and keep the offset. Crucially, run all measurement math on the f64 model + offset, not on f32 GPU coordinates.
- **Performance** on drawings with hundreds of thousands of entities — batch/instance geometry (`InstancedMesh` for repeated blocks), frustum-cull, consider LOD. WebGL from day one (not Canvas2D) is why this stays tractable. Watch the interaction with fat-line geometry above.
- **Units correctness** — verify measured distances against a drawing with known real dimensions; a wrong scale factor is silent and dangerous.
- **WASM size / GPL** (option A only) — drives the internal-vs-shipped decision; settle it before Phase 3, not during.

---

## 6. Rough effort

Solid DXF prototype with measurement: a few weeks. A version robust enough for friendly internal users, plus DWG input: roughly 1–2 months end to end. True real-world fidelity (text, hatches, lineweights, OCS edge cases) is an open-ended long tail beyond that — it doesn't compress to a fixed estimate, so treat the 1–2 month figure as "robust enough to deploy internally," not "handles every drawing perfectly."
