import { describe, expect, it } from 'vitest';
import { decompose, multiply, rotation, scaling, translation } from './matrix.js';

describe('decompose', () => {
  it('returns identity for the identity transform', () => {
    const d = decompose([1, 0, 0, 1, 0, 0]);
    expect(d.rotation).toBeCloseTo(0);
    expect(d.scaleX).toBeCloseTo(1);
    expect(d.scaleY).toBeCloseTo(1);
    expect(d.reflected).toBe(false);
  });

  it('recovers rotation and ignores translation', () => {
    const m = multiply(translation(100, -50), rotation(Math.PI / 6));
    const d = decompose(m);
    expect(d.rotation).toBeCloseTo(Math.PI / 6);
    expect(d.scaleX).toBeCloseTo(1);
    expect(d.scaleY).toBeCloseTo(1);
  });

  it('recovers non-uniform scale composed with rotation', () => {
    const m = multiply(rotation(Math.PI / 4), scaling(2, 3));
    const d = decompose(m);
    expect(d.rotation).toBeCloseTo(Math.PI / 4);
    expect(d.scaleX).toBeCloseTo(2);
    expect(d.scaleY).toBeCloseTo(3);
    expect(d.reflected).toBe(false);
  });

  it('flags a mirror with non-negative scales', () => {
    const d = decompose(scaling(-1, 1));
    expect(d.reflected).toBe(true);
    expect(d.scaleX).toBeCloseTo(1);
    expect(d.scaleY).toBeCloseTo(1);
  });
});
