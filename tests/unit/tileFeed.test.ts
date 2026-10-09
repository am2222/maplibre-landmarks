import { describe, expect, it, vi } from 'vitest';
import type { FeedFeature, FeedMap } from '../../src/core/tileFeed';
import { TileFeed, tileBounds, tileKey } from '../../src/core/tileFeed';

const feature = (id: number, tile?: { z: number; x: number; y: number }): FeedFeature => ({
  id,
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties: {},
  ...(tile ? { tile } : {}),
});

/** A MapLibre tile as the `sourcedata` event carries it. */
function fakeTile(z: number, x: number, y: number, features: FeedFeature[]) {
  return {
    tileID: { canonical: { z, x, y } },
    querySourceFeatures: vi.fn((result: FeedFeature[], _params?: object) => {
      result.push(...features);
    }),
  };
}

/** Lng/lat of a tile's centre. */
function centreOf(z: number, x: number, y: number): [number, number] {
  const [w, s, e, n] = tileBounds(tileKey({ z, x, y }));
  return [(w + e) / 2, (s + n) / 2];
}

function fakeMap() {
  const handlers = new Map<string, (e: unknown) => void>();
  let bounds: [number, number, number, number] = [-180, -85, 180, 85];
  const map = {
    handlers,
    setBounds: (b: [number, number, number, number]) => (bounds = b),
    on: vi.fn((type: string, fn: (e: unknown) => void) => handlers.set(type, fn)),
    off: vi.fn((type: string) => handlers.delete(type)),
    getSource: () => ({ maxzoom: 15 }),
    getBounds: () => ({
      getWest: () => bounds[0],
      getSouth: () => bounds[1],
      getEast: () => bounds[2],
      getNorth: () => bounds[3],
    }),
    querySourceFeatures: vi.fn((): FeedFeature[] => []),
    emit: (e: object) => handlers.get('sourcedata')!({ sourceId: 'src', ...e }),
  };
  return map;
}

function setup(over: Partial<ConstructorParameters<typeof TileFeed>[1]> = {}) {
  const map = fakeMap();
  const onTile = vi.fn();
  const onDrop = vi.fn();
  const feed = new TileFeed(map as unknown as FeedMap, {
    source: 'src',
    sourceLayer: 'landuse',
    filter: ['==', 'kind', 'park'],
    onTile,
    onDrop,
    ...over,
  });
  return { map, feed, onTile, onDrop };
}

describe('TileFeed', () => {
  it("delivers each arriving tile's own features once, through the event's tile", () => {
    const { map, feed, onTile } = setup();
    const tile = fakeTile(15, 16594, 11272, [feature(1), feature(2)]);
    map.emit({ sourceId: 'other', tile: fakeTile(15, 1, 1, [feature(9)]) });
    map.emit({ tile });
    expect(tile.querySourceFeatures).toHaveBeenCalledWith(expect.any(Array), {
      sourceLayer: 'landuse',
      filter: ['==', 'kind', 'park'],
    });
    expect(onTile).toHaveBeenCalledTimes(1);
    expect(onTile).toHaveBeenCalledWith('15/16594/11272', [feature(1), feature(2)]);
    expect(feed.fastPath).toBe(true);
    expect(feed.keys()).toEqual(['15/16594/11272']);
  });

  it('replaces a reloaded tile (the same tile object fires again: drop, then arrive)', () => {
    const { map, onTile, onDrop } = setup();
    const tile = fakeTile(15, 1, 2, [feature(1)]);
    map.emit({ tile });
    tile.querySourceFeatures.mockImplementation((result: FeedFeature[]) => {
      result.push(feature(1), feature(3));
    });
    map.emit({ tile });
    expect(onDrop).toHaveBeenCalledWith('15/1/2');
    expect(onTile).toHaveBeenCalledTimes(2);
    expect(onTile).toHaveBeenLastCalledWith('15/1/2', [feature(1), feature(3)]);
  });

  it('keys overscaled tiles by their data tile, processing the data once', () => {
    const { map, feed, onTile, onDrop } = setup();
    // Two overscaled tile objects (zoom 17 and 18) showing the same z15 data tile.
    map.emit({ tile: fakeTile(15, 7, 8, [feature(1)]) });
    map.emit({ tile: fakeTile(15, 7, 8, [feature(1)]) });
    expect(feed.keys()).toEqual(['15/7/8']);
    expect(onTile).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('drops tiles outside the view (padded by one tile) when the camera settles', () => {
    const { map, feed, onDrop } = setup();
    const [lng, lat] = centreOf(15, 16594, 11272);
    map.emit({ tile: fakeTile(15, 16594, 11272, []) });
    map.emit({ tile: fakeTile(15, 16595, 11272, []) }); // next to it: in the padding
    map.emit({ tile: fakeTile(15, 16700, 11272, []) }); // far away
    const d = 0.001;
    map.setBounds([lng - d, lat - d, lng + d, lat + d]);
    feed.settle();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('15/16700/11272');
    expect(feed.keys().sort()).toEqual(['15/16594/11272', '15/16595/11272']);
  });

  it('drops a parent tile once all four children are held, not before', () => {
    const { map, feed, onDrop } = setup();
    map.emit({ tile: fakeTile(14, 8297, 5636, []) });
    map.emit({ tile: fakeTile(15, 16594, 11272, []) });
    map.emit({ tile: fakeTile(15, 16595, 11272, []) });
    map.emit({ tile: fakeTile(15, 16594, 11273, []) });
    feed.settle();
    expect(onDrop).not.toHaveBeenCalled();
    map.emit({ tile: fakeTile(15, 16595, 11273, []) });
    feed.settle();
    expect(onDrop).toHaveBeenCalledWith('14/8297/5636');
    expect(feed.keys()).not.toContain('14/8297/5636');
  });

  it('re-queries a held tile on demand, and forgets it after a drop', () => {
    const { map, feed } = setup();
    const tile = fakeTile(15, 1, 2, [feature(1)]);
    map.emit({ tile });
    expect(feed.featuresOf('15/1/2')).toEqual([feature(1)]);
    expect(tile.querySourceFeatures).toHaveBeenCalledTimes(2);
    feed.reset();
    expect(feed.featuresOf('15/1/2')).toBeUndefined();
  });

  it('reset drops every tile; dispose stops listening', () => {
    const { map, feed, onDrop } = setup();
    map.emit({ tile: fakeTile(15, 1, 2, []) });
    map.emit({ tile: fakeTile(15, 3, 4, []) });
    feed.reset();
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(feed.keys()).toEqual([]);
    feed.dispose();
    expect(map.off).toHaveBeenCalledWith('sourcedata', expect.any(Function));
  });

  it('caps the tiles it holds, dropping the farthest first', () => {
    const { map, feed, onDrop } = setup({ maxTiles: 2 });
    const [lng, lat] = centreOf(15, 100, 100);
    map.setBounds([lng - 1, lat - 1, lng + 1, lat + 1]);
    map.emit({ tile: fakeTile(15, 100, 100, []) });
    map.emit({ tile: fakeTile(15, 101, 100, []) });
    map.emit({ tile: fakeTile(15, 110, 100, []) });
    feed.settle();
    expect(onDrop).toHaveBeenCalledWith('15/110/100');
    expect(feed.keys()).toHaveLength(2);
  });

  it('falls back to the public query, grouped by tile, when events carry no tile', () => {
    const { map, feed, onTile, onDrop } = setup();
    const a = { z: 15, x: 1, y: 2 };
    const b = { z: 15, x: 3, y: 4 };
    map.querySourceFeatures.mockReturnValue([feature(1, a), feature(2, a), feature(3, b)]);
    map.emit({ sourceDataType: 'content' });
    feed.settle();
    expect(feed.fastPath).toBe(false);
    expect(map.querySourceFeatures).toHaveBeenCalledWith('src', {
      sourceLayer: 'landuse',
      filter: ['==', 'kind', 'park'],
    });
    expect(onTile).toHaveBeenCalledWith('15/1/2', [feature(1, a), feature(2, a)]);
    expect(onTile).toHaveBeenCalledWith('15/3/4', [feature(3, b)]);
    map.querySourceFeatures.mockReturnValue([feature(1, a), feature(2, a)]);
    map.emit({ sourceDataType: 'content' });
    feed.settle();
    expect(onDrop).toHaveBeenCalledWith('15/3/4');
  });

  it('seeds tiles loaded before it existed on the first settle, then follows events only', () => {
    const { map, feed, onTile } = setup();
    const a = { z: 15, x: 16594, y: 11272 };
    map.querySourceFeatures.mockReturnValue([feature(1, a)]);
    feed.settle();
    expect(onTile).toHaveBeenCalledWith('15/16594/11272', [feature(1, a)]);
    map.emit({ tile: fakeTile(15, 16595, 11272, [feature(2)]) });
    map.querySourceFeatures.mockClear();
    feed.settle();
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    expect(feed.keys().sort()).toEqual(['15/16594/11272', '15/16595/11272']);
  });

  it('without the fast path, delivers a tile again when its features change', () => {
    const { map, feed, onTile, onDrop } = setup();
    map.querySourceFeatures.mockReturnValue([feature(1), feature(2)]);
    feed.settle();
    map.querySourceFeatures.mockReturnValue([feature(1), feature(2), feature(3)]);
    feed.settle();
    expect(onDrop).toHaveBeenCalledWith('*');
    expect(onTile).toHaveBeenLastCalledWith('*', [feature(1), feature(2), feature(3)]);
  });

  it("holds exactly the tile manager's renderable tiles on settle (a zoom-out drops children)", () => {
    const { map, feed, onTile, onDrop } = setup();
    const children = [
      fakeTile(15, 16594, 11272, [feature(1)]),
      fakeTile(15, 16595, 11272, [feature(2)]),
    ];
    for (const tile of children) map.emit({ tile });
    const parent = fakeTile(14, 8297, 5636, [feature(3)]);
    let renderable = [parent];
    const manager = {
      getRenderableIds: () => renderable.map((_, i) => i),
      getTileByID: (i: number) => renderable[i],
    };
    Object.assign(map, { style: { tileManagers: { src: manager } } });
    feed.settle();
    expect(onDrop).toHaveBeenCalledWith('15/16594/11272');
    expect(onDrop).toHaveBeenCalledWith('15/16595/11272');
    expect(onTile).toHaveBeenLastCalledWith('14/8297/5636', [feature(3)]);
    expect(feed.keys()).toEqual(['14/8297/5636']);
    expect(map.querySourceFeatures).not.toHaveBeenCalled();
    // A broken manager (a MapLibre change): the rules decide again, nothing is dropped blindly.
    renderable = [{ tileID: {} } as never];
    expect(() => feed.settle()).not.toThrow();
    expect(feed.keys()).toEqual(['14/8297/5636']);
  });

  it('suspended (layer hidden or zoomed out): holds nothing and ignores arrivals until settled', () => {
    const { map, feed, onTile, onDrop } = setup();
    map.emit({ tile: fakeTile(15, 1, 2, [feature(1)]) });
    feed.suspend();
    expect(onDrop).toHaveBeenCalledWith('15/1/2');
    map.emit({ tile: fakeTile(15, 3, 4, [feature(2)]) });
    expect(onTile).toHaveBeenCalledTimes(1);
    expect(feed.keys()).toEqual([]);
    map.querySourceFeatures.mockReturnValue([feature(3, { z: 15, x: 16594, y: 11272 })]);
    feed.settle(); // active again: seeded from what is loaded now
    expect(feed.keys()).toEqual(['15/16594/11272']);
  });

  it('starts over when the source is replaced under the same id (a diffed setStyle)', () => {
    const { map, feed, onTile, onDrop } = setup();
    const managerOf = (tiles: ReturnType<typeof fakeTile>[]) => ({
      getRenderableIds: () => tiles.map((_, i) => i),
      getTileByID: (i: number) => tiles[i],
    });
    Object.assign(map, {
      style: { tileManagers: { src: managerOf([fakeTile(15, 16594, 11272, [feature(1)])]) } },
    });
    feed.settle();
    // The new source's tile announces itself before the next settle: same key, new data.
    const fresh = fakeTile(15, 16594, 11272, [feature(2)]);
    Object.assign(map, { style: { tileManagers: { src: managerOf([fresh]) } } });
    map.emit({ tile: fresh });
    expect(onDrop).toHaveBeenCalledWith('15/16594/11272');
    expect(onTile).toHaveBeenLastCalledWith('15/16594/11272', [feature(2)]);
    feed.settle();
    expect(onTile).toHaveBeenCalledTimes(2);
  });

  it('says once, in development builds, that a source fell back to the slow path', async () => {
    vi.resetModules();
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { TileFeed: Fresh } = await import('../../src/core/tileFeed');
      const map = fakeMap();
      const options = { source: 'src', onTile: vi.fn(), onDrop: vi.fn() };
      const a = new Fresh(map as unknown as FeedMap, options);
      const b = new Fresh(map as unknown as FeedMap, options);
      a.settle(); // seeding: not a fallback yet
      expect(info).not.toHaveBeenCalled();
      for (const feed of [a, b, a, b]) feed.settle();
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0]![0])).toContain('src');
    } finally {
      process.env.NODE_ENV = env;
      info.mockRestore();
    }
  });

  it('holds tiles its layer does not want yet without reading them', () => {
    const { map, feed, onTile } = setup({ wants: (key: string) => key !== '15/1/2' });
    const skipped = fakeTile(15, 1, 2, [feature(1)]);
    map.emit({ tile: skipped });
    expect(skipped.querySourceFeatures).not.toHaveBeenCalled();
    expect(onTile).not.toHaveBeenCalled();
    expect(feed.keys()).toEqual(['15/1/2']);
    expect(feed.featuresOf('15/1/2')).toEqual([feature(1)]); // read on demand
  });

  it('tells which parts of a parent tile its held children already draw', () => {
    const { map, feed } = setup();
    map.emit({ tile: fakeTile(14, 8297, 5636, []) });
    map.emit({ tile: fakeTile(15, 16594, 11272, []) }); // north-west child
    const inside = (key: string, fx: number, fy: number): [number, number, number, number] => {
      const [w, s, e, n] = tileBounds(key);
      const [x, y] = [w + (e - w) * fx, s + (n - s) * fy];
      return [x, y, x, y];
    };
    const parent = '14/8297/5636';
    expect(feed.shadowed(parent, inside(parent, 0.25, 0.75))).toBe(true); // in the child
    expect(feed.shadowed(parent, inside(parent, 0.75, 0.75))).toBe(false); // child missing
    const across = [
      ...inside(parent, 0.25, 0.75).slice(0, 2),
      ...inside(parent, 0.75, 0.75).slice(2),
    ];
    expect(feed.shadowed(parent, across as never)).toBe(false);
    expect(feed.shadowed('15/16594/11272', inside('15/16594/11272', 0.5, 0.5))).toBe(false);
  });

  it('delivers a held tile once its layer wants it (the far cutoff moved out)', () => {
    let far = true;
    const { map, feed, onTile } = setup({
      wants: (key: string) => key !== '15/16594/11272' || !far,
    });
    const tile = fakeTile(15, 16594, 11272, [feature(1)]);
    map.emit({ tile });
    feed.settle();
    expect(onTile).not.toHaveBeenCalled();
    far = false;
    feed.settle();
    expect(onTile).toHaveBeenCalledWith('15/16594/11272', [feature(1)]);
    feed.settle();
    expect(onTile).toHaveBeenCalledTimes(1);
  });

  it('treats features without tile information as one pseudo-tile', () => {
    const { map, feed, onTile } = setup();
    map.querySourceFeatures.mockReturnValue([feature(1), feature(2)]);
    map.emit({ sourceDataType: 'content' });
    feed.settle();
    expect(onTile).toHaveBeenCalledWith('*', [feature(1), feature(2)]);
  });
});
