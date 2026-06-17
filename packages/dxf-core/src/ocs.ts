import type { Affine } from './types.js';
import { IDENTITY } from './matrix.js';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

const THRESHOLD = 1 / 64;

/**
 * Object Coordinate System → World, projected onto the WCS XY plane, as a 2D
 * affine (the "arbitrary axis algorithm", DXF group codes 210/220/230).
 *
 * For the overwhelmingly common extrusion (0,0,1) this returns identity; (0,0,-1)
 * yields an X mirror. Ignoring this silently mirrors or misplaces geometry — the
 * classic "drawing is backwards" bug. `elevation` is the entity's Z in OCS.
 */
export function ocsToAffine(
  extrusion: Vec3 | undefined,
  elevation = 0,
): Affine {
  if (!extrusion) return IDENTITY;
  const n = normalize(extrusion);
  // Fast path: already aligned with +Z.
  if (n.x === 0 && n.y === 0 && n.z === 1) return IDENTITY;

  const ax =
    Math.abs(n.x) < THRESHOLD && Math.abs(n.y) < THRESHOLD
      ? cross({ x: 0, y: 1, z: 0 }, n)
      : cross({ x: 0, y: 0, z: 1 }, n);
  const axN = normalize(ax);
  const ay = normalize(cross(n, axN));

  // WCS = x*ax + y*ay + elevation*n ; keep the XY projection.
  return [axN.x, axN.y, ay.x, ay.y, n.x * elevation, n.y * elevation];
}
