import type { Affine, Vec2 } from './types.js';

/** Identity affine. */
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/**
 * Compose two affines: returns `outer ∘ inner`, i.e. the transform that applies
 * `inner` first and then `outer`. Used to push child transforms through nested
 * block INSERTs.
 */
export function multiply(outer: Affine, inner: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Apply an affine to a point. */
export function apply(m: Affine, p: Vec2): Vec2 {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

export function translation(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}

export function scaling(sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotation by `angle` radians (CCW). */
export function rotation(angle: number): Affine {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, -s, c, 0, 0];
}

/** True when the transform flips orientation (e.g. negative/mirrored scale). */
export function isReflecting(m: Affine): boolean {
  const det = m[0] * m[3] - m[1] * m[2];
  return det < 0;
}

export interface Decomposed {
  /** Rotation of the local X axis into world, radians CCW. */
  rotation: number;
  /** Non-negative scale along the local X axis. */
  scaleX: number;
  /** Non-negative scale along the local Y axis. */
  scaleY: number;
  /** True when the transform mirrors (negative determinant). */
  reflected: boolean;
}

/**
 * Decompose an affine into rotation + per-axis scale (translation dropped).
 * Used to place primitives that need a single angle and size rather than a full
 * matrix — e.g. text, whose glyph layout the renderer can't express as a 2×3.
 * Scales are kept non-negative; a mirror surfaces via `reflected` instead of a
 * negative scale (matrix math can't tell which axis was flipped, and callers
 * generally want to keep glyphs readable rather than mirror them).
 */
export function decompose(m: Affine): Decomposed {
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  const scaleX = Math.hypot(a, b);
  // Recover Y scale from the signed area so a uniform scale round-trips exactly;
  // fall back to the raw column length for a degenerate (zero-width) X axis.
  const scaleY = scaleX === 0 ? Math.hypot(c, d) : Math.abs(det) / scaleX;
  return { rotation: Math.atan2(b, a), scaleX, scaleY, reflected: det < 0 };
}
