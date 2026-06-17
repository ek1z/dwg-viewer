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
- **Astro 6** — app shell, routing, the file-open page, layout. The viewer itself is a `client:only="react"` island (all parsing/WebGL is browser-side; SSR buys nothing here).
- **TypeScript**, strict.
- **three.js** — WebGL rendering. Use an orthographic camera for true 2D; build geometry from parsed entities.
- **DXF parsing** — `dxf-parser` (or `@dxfom/*`) for the MVP. Evaluate both in the Phase 0 spike against real files.
- **DWG parsing (later)** — `@mlightcad/libredwg-web` (option A) or LibreDWG `dwg2dxf` CLI (option B).
- **Spatial index for snapping** — `flatbush` or `rbush` (R-tree) over entity endpoints/midpoints/intersections.
- **State** — Zustand for viewer + active-tool + measurement state.
- **Styling** — StyleX.
- **Library builds** — tsdown for the `packages/*` builds.
- **Testing** — Vitest (unit), Playwright (E2E in-browser).

---

## 4. Phases & milestones

**Phase 0 — Spikes / derisking (~1 week).** Collect a corpus of *real* drawings from actual users. Run candidate DXF parsers + viewer libraries against them. Confirm: layers, blocks/INSERTs, line types, hatches, text, dimension entities, and model-vs-paper-space layouts all come through. This is the single most important phase — fidelity problems found here are cheap; found in Phase 3 they're expensive.

**Phase 1 — DXF viewer MVP (~2–3 weeks).** `dxf-core` produces a normalized scene model; `viewer-engine` renders it in three.js with smooth pan/zoom and a layer panel (show/hide). Astro app gets a file-open flow. Deliverable: open a DXF, see it correctly, navigate it.

**Phase 2 — Measurement (~2 weeks).** The differentiator, and it's custom work:
- Screen ↔ world coordinate transform.
- Object snapping (endpoint, midpoint, intersection, nearest) via the spatial index, with a visual snap marker.
- Unit handling — read `$INSUNITS` / `$MEASUREMENT` from the DXF header and apply the scale factor so distances read in real units.
- Tools: point-to-point distance first, then cumulative/polyline, area, and angle.
- Annotations drawn on an overlay layer above the scene.

**Phase 3 — DWG input (~1–2 weeks).** Wire in the chosen conversion path (A or B). The rest of the app is untouched because everything downstream consumes the normalized model.

**Phase 4 — Hardening.** Large-file performance, edge cases from the corpus, keyboard/accessibility, persistence of measurement sessions if wanted.

---

## 5. Technical risks to watch

- **Parsing fidelity** on messy real-world files — derisk in Phase 0, never with synthetic samples only.
- **Float32 precision (subtle but real):** CAD drawings often carry large absolute coordinates (survey coords in the millions); WebGL uses 32-bit floats and will visibly jitter/snap-wrong at that magnitude. Fix: rebase the scene to a local origin on load and keep the offset for converting measurements back to world coordinates.
- **Performance** on drawings with hundreds of thousands of entities — batch/instance geometry, frustum-cull, consider LOD. WebGL from day one (not Canvas2D) is why this stays tractable.
- **Units correctness** — verify measured distances against a drawing with known real dimensions; a wrong scale factor is silent and dangerous.
- **WASM size / GPL** (option A only) — drives the internal-vs-shipped decision; settle it before Phase 3, not during.

---

## 6. Rough effort

Solid DXF prototype with measurement: a few weeks. Robust version handling real-world drawings, plus DWG input: roughly 1–2 months end to end.
