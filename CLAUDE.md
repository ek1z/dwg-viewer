# CLAUDE.md

Guidance for working in this repository. Read this first; it captures the
invariants that aren't obvious from any single file.

## What this is

A read-only, fully client-side browser CAD viewer: open a `.dxf` or `.dwg`,
render it, navigate it (pan/zoom + layer toggles), and measure it (distance,
area, angle) with object snapping. Data never leaves the device — conversion,
parsing, rendering and measurement all run in the browser.

The full product spec / phasing lives in
[`docs/plans/web-dwg-dxf-viewer.md`](docs/plans/web-dwg-dxf-viewer.md). When a
change touches behavior, check it against that plan and keep `README.md` in sync.

## Monorepo layout

pnpm workspace (`pnpm-workspace.yaml`), Node ≥ 22, packageManager `pnpm@10.x`.

```
apps/web                  Astro shell; mounts the viewer as a client:only React island
packages/dxf-core         DXF → normalized, framework-agnostic float64 scene model
packages/dwg-core         DWG → DXF (libredwg WASM) → dxf-core scene model
packages/viewer-engine    three.js renderer: tessellation, rebasing, pan/zoom, layers
packages/viewer-react     React island: engine + toolbar + layer panel + measurement overlay
packages/measure          snapping (R-tree) + distance/area/angle math + unit-aware formatting
```

All `@dwg-viewer/*` packages are **internal / source-consumed**: their `exports`
point at TypeScript source, so Vite/Astro transpiles them on the fly with no
build step in dev. `pnpm build` still emits `dist/` (tsdown) for standalone use.

`dxf-core`, `viewer-engine`, and `measure` are pure TypeScript with no framework
dependency and must stay that way (they're tested in isolation). `viewer-react`
is the only package allowed to touch React.

## Commands

```bash
pnpm install
pnpm dev          # Astro dev server (apps/web)
pnpm build        # pnpm -r build (web app + library dist/)
pnpm test         # pnpm -r test (vitest)
pnpm typecheck    # pnpm -r typecheck (astro check in web, tsc --noEmit in libs)
```

There is **no ESLint** in this repo — `typecheck` + `test` are the gates. Run
both before considering a change done; a Stop hook (`.claude/hooks/verify.sh`)
runs `typecheck` automatically when the working tree is dirty.

Scope work to a single package when you can:
`pnpm --filter @dwg-viewer/dxf-core test`.

## Invariants — don't break these

- **float64 world model.** The scene model and all measurement math run in
  double precision. The engine rebases large absolute coordinates to a local
  origin and pushes only f32 to the GPU; `screenToWorld()` re-adds the offset.
  Never measure against f32 GPU coordinates.
- **Curves stay parametric in `dxf-core`.** Arcs, ellipses, splines and polyline
  bulges are kept as parameters; `viewer-engine` owns tessellation. Don't
  tessellate in the parse layer.
- **License isolation.** `@mlightcad/libredwg-web` is GPL and lives **only** in
  `dwg-core`, behind a dynamic import (the ~7 MB WASM loads once, on first DWG
  open). Keep `dxf-core` and everything downstream license-clean — never import
  the WASM outside `dwg-core`.
- **One pipeline for both formats.** DWG is converted to DXF and fed through the
  exact same `parseDxf` path. Nothing downstream of the parse step should know
  which format the file started as.
- **Strict TS.** `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `isolatedModules`. Respect them (e.g. use
  `import type`); don't loosen the base config to make code pass.

## Subagents

- **explorer** (`.claude/agents/explorer.md`) — read-only; map how a feature is
  wired before editing. `> use the explorer to map how content feeds the viewer`
- **reviewer** (`.claude/agents/reviewer.md`) — after coding, review the diff
  against the spec and run the gates. `> use the reviewer to check the diff`

## PR descriptions

Write PR bodies with this structure (markdown), not a copy of the commit message:

- **What & why** — a short paragraph: what changed and the reason/context.
- **Changes** — a table (`File | Change`) of the files touched and the concrete
  edit in each; call out anything intentionally left unchanged and why.
- **Breaking changes that don't apply** — when relevant (e.g. a dep major bump),
  list the breaking changes that were considered but don't affect this repo.
- **Verification** — bullet each gate with a status marker: ✅ done/passing,
  ⚠️ caveat or known gap (state it honestly, e.g. a pre-existing issue),
  ⏭️ not run and why. Cover build, tests, typecheck; note anything not exercised.
- Add short notes for non-obvious warnings or follow-ups.

Keep the git trailers (`Co-Authored-By`, `Claude-Session`) out of the PR body —
they belong only in the commit message. End the body with the
"🤖 Generated with Claude Code" footer.
