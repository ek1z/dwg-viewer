import { beforeEach, describe, expect, it } from 'vitest';
import type { Vec2 } from '@dwg-viewer/dxf-core';
import { useViewerStore } from './store.js';

const add = (p: Vec2): void => useViewerStore.getState().addPrintCorner(p);

beforeEach(() => {
  useViewerStore.setState({
    tool: null,
    draftPoints: [],
    hover: null,
    snap: null,
    measurements: [],
    printMode: false,
    printCorners: [],
    printHover: null,
    printRegion: null,
  });
});

describe('print region store', () => {
  it('commits a normalized region from two corners (any drag direction)', () => {
    useViewerStore.getState().setPrintMode(true);
    add({ x: 30, y: 40 });
    add({ x: 10, y: 5 });
    const { printRegion, printCorners } = useViewerStore.getState();
    expect(printRegion).toEqual({ min: { x: 10, y: 5 }, max: { x: 30, y: 40 } });
    expect(printCorners).toEqual([]);
  });

  it('rejects a degenerate second corner (e.g. double-click)', () => {
    useViewerStore.getState().setPrintMode(true);
    add({ x: 10, y: 10 });
    add({ x: 10, y: 10 });
    expect(useViewerStore.getState().printRegion).toBeNull();
    expect(useViewerStore.getState().printCorners).toEqual([{ x: 10, y: 10 }]);
  });

  it('starts a fresh region when clicking after one is committed', () => {
    useViewerStore.getState().setPrintMode(true);
    add({ x: 0, y: 0 });
    add({ x: 10, y: 10 });
    add({ x: 5, y: 5 });
    expect(useViewerStore.getState().printRegion).toBeNull();
    expect(useViewerStore.getState().printCorners).toEqual([{ x: 5, y: 5 }]);
  });

  it('ignores corners placed when print mode is off', () => {
    add({ x: 1, y: 2 });
    expect(useViewerStore.getState().printCorners).toEqual([]);
  });

  it('clears print state when a measure tool is selected, and vice versa', () => {
    useViewerStore.getState().setPrintMode(true);
    add({ x: 0, y: 0 });
    useViewerStore.getState().setTool('distance');
    let st = useViewerStore.getState();
    expect(st.printMode).toBe(false);
    expect(st.printCorners).toEqual([]);
    expect(st.printRegion).toBeNull();

    useViewerStore.getState().setPrintMode(true);
    st = useViewerStore.getState();
    expect(st.tool).toBeNull();
    expect(st.draftPoints).toEqual([]);
  });
});
