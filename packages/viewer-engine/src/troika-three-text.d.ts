/**
 * Minimal ambient types for `troika-three-text` (it ships no `.d.ts`, and there
 * is no `@types/troika-three-text`). Only the surface the engine uses is typed.
 */
declare module 'troika-three-text' {
  import { Mesh, Color, Material } from 'three';

  /** SDF text mesh; layout properties are applied then committed via `sync()`. */
  export class Text extends Mesh {
    text: string;
    /** URL of a .ttf/.otf/.woff font; null uses troika's bundled default. */
    font: string | null;
    /** Em-box height in local (world) units. */
    fontSize: number;
    color: number | string | Color;
    anchorX: number | string;
    anchorY: number | string;
    textAlign: string;
    maxWidth: number;
    lineHeight: number | string;
    letterSpacing: number;
    material: Material | Material[];
    /** Recompute layout/geometry; callback fires once ready. */
    sync(callback?: () => void): void;
    /** Release geometry, derived material and SDF resources. */
    dispose(): void;
  }

  export function preloadFont(
    options: { font?: string; characters?: string | string[] },
    callback: () => void,
  ): void;
}
