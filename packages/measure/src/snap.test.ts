import { describe, it, expect } from 'vitest';
import { SnapBuilder } from './snap.js';

describe('SnapIndex', () => {
  it('is empty with no geometry', () => {
    const idx = new SnapBuilder().build();
    expect(idx.isEmpty).toBe(true);
    expect(idx.query({ x: 0, y: 0 }, 1)).toBeNull();
  });

  it('snaps to the nearest endpoint within tolerance', () => {
    const b = new SnapBuilder();
    b.addPoint(0, 0, 'endpoint');
    b.addPoint(10, 0, 'endpoint');
    const idx = b.build();
    const r = idx.query({ x: 0.3, y: 0.2 }, 1);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('endpoint');
    expect(r!.point).toEqual({ x: 0, y: 0 });
  });

  it('returns null when nothing is within tolerance', () => {
    const b = new SnapBuilder();
    b.addPoint(0, 0, 'endpoint');
    expect(b.build().query({ x: 5, y: 5 }, 1)).toBeNull();
  });

  it('prefers endpoint over midpoint at the same location', () => {
    const b = new SnapBuilder();
    b.addPoint(0, 0, 'midpoint');
    b.addPoint(0, 0, 'endpoint');
    const r = b.build().query({ x: 0.1, y: 0 }, 1);
    expect(r!.kind).toBe('endpoint');
  });

  it('prefers an in-tolerance endpoint over a closer nearest-on-segment', () => {
    const b = new SnapBuilder();
    // Endpoint slightly away from the cursor…
    b.addPoint(0.5, 0, 'endpoint');
    // …and a segment passing right under the cursor (nearest would be closer).
    b.addSegment(-10, 0.1, 10, 0.1);
    const r = b.build().query({ x: 0, y: 0 }, 1);
    expect(r!.kind).toBe('endpoint');
  });

  it('snaps to nearest point on a segment when no vertex is near', () => {
    const b = new SnapBuilder();
    b.addSegment(-10, 0, 10, 0);
    const r = b.build().query({ x: 3, y: 0.2 }, 1);
    expect(r!.kind).toBe('nearest');
    expect(r!.point.x).toBeCloseTo(3, 9);
    expect(r!.point.y).toBeCloseTo(0, 9);
  });

  it('finds a lazily-computed intersection of two crossing segments', () => {
    const b = new SnapBuilder();
    b.addSegment(-10, 0, 10, 0);
    b.addSegment(0, -10, 0, 10);
    const r = b.build().query({ x: 0.2, y: 0.2 }, 1);
    expect(r!.kind).toBe('intersection');
    expect(r!.point.x).toBeCloseTo(0, 9);
    expect(r!.point.y).toBeCloseTo(0, 9);
  });

  it('stays exact at large survey coordinates', () => {
    const b = new SnapBuilder();
    b.addPoint(1_000_000, 2_000_000, 'endpoint');
    const r = b.build().query({ x: 1_000_000.2, y: 2_000_000.1 }, 1);
    expect(r!.point).toEqual({ x: 1_000_000, y: 2_000_000 });
  });
});
