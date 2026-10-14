"""Encode 3D building surfaces (NDJSON from 3DCityDB) into Vienna-style 3D MVT tiles in a PMTiles archive.

Each line: {"b": building id, "k": "roof"|"wall", "tx", "ty": z15 tile of the building's centre,
            "g": MultiPolygon Z coordinates in EPSG:3857 metres}.

Tile format (matches the Maptoolkit `fill-3d` decoder):
  - one feature per building per kind, geometry type 0 (UNKNOWN), tag `type` = roof|wall
  - every vertex is (dx, dy, dz) zigzag deltas; x/y in tile units (extent 4096), z in decimetres
  - first ring is a 2-point header: (minX, minY, minZ) -> (maxX, maxY, maxZ) of the whole building
  - ClosePath count 2 ends a polygon's exterior (starts a new polygon); count 1 ends a hole
  - buildings are not clipped: the whole building lives in the tile holding its centre
"""

import gzip
import json
import math
import sys
from collections import defaultdict

from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

Z = 15
EXTENT = 4096
WORLD = 40075016.68557849
HALF = WORLD / 2
TILE_M = WORLD / 2**Z


def zigzag(n):
    return (n << 1) ^ (n >> 63)


def varint(n, out):
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def field_bytes(tag, payload, out):
    varint((tag << 3) | 2, out)
    varint(len(payload), out)
    out.extend(payload)


def field_varint(tag, value, out):
    varint(tag << 3, out)
    varint(value, out)


def packed(values):
    out = bytearray()
    for v in values:
        varint(v, out)
    return out


class Geom:
    """Command stream with a cursor shared across the whole feature."""

    def __init__(self):
        self.cmds = []
        self.cur = (0, 0, 0)

    def cmd(self, cid, count):
        self.cmds.append((cid & 7) | (count << 3))

    def point(self, p):
        for a, b in zip(p, self.cur):
            self.cmds.append(zigzag(a - b))
        self.cur = p

    def ring(self, pts, close_count):
        self.cmd(1, 1)
        self.point(pts[0])
        self.cmd(2, len(pts) - 1)
        for p in pts[1:]:
            self.point(p)
        self.cmd(7, close_count)


def quantize_ring(ring, tx, ty):
    x0 = tx * TILE_M - HALF
    y0 = HALF - ty * TILE_M
    pts = []
    for x, y, z in ring:
        p = (round((x - x0) / TILE_M * EXTENT), round((y0 - y) / TILE_M * EXTENT), round(z * 10))
        if not pts or pts[-1] != p:
            pts.append(p)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(set(pts)) < 3:
        return None
    # zero-area after quantization (collinear points): no usable normal, nothing to draw
    nx = ny = nz = 0
    for (ax, ay, az), (bx, by, bz) in zip(pts, pts[1:] + pts[:1]):
        nx += (ay - by) * (az + bz)
        ny += (az - bz) * (ax + bx)
        nz += (ax - bx) * (ay + by)
    return pts if (nx, ny, nz) != (0, 0, 0) else None


def encode_tile(buildings):
    keys, values = ["type"], ["roof", "wall"]
    features = []
    stats = defaultdict(int)
    for bid, kinds in buildings.items():
        polys = {k: [] for k in kinds}
        allpts = []
        for kind, surfaces in kinds.items():
            for tx, ty, mp in surfaces:
                for poly in mp:
                    rings = [quantize_ring(r, tx, ty) for r in poly]
                    if rings[0] is None:
                        stats["dropped_polygons"] += 1
                        continue
                    rings = [rings[0]] + [r for r in rings[1:] if r]
                    polys[kind].append(rings)
                    allpts.extend(p for r in rings for p in r)
        if not allpts:
            continue
        lo = tuple(min(p[i] for p in allpts) for i in range(3))
        hi = tuple(max(p[i] for p in allpts) for i in range(3))
        for kind, plist in polys.items():
            if not plist:
                continue
            g = Geom()
            g.cmd(1, 1)
            g.point(lo)
            g.cmd(2, 1)
            g.point(hi)
            g.cmd(7, 2)
            for rings in plist:
                g.ring(rings[0], 2)
                for hole in rings[1:]:
                    g.ring(hole, 1)
            stats["features"] += 1
            stats["polygons"] += len(plist)
            stats["vertices"] += sum(len(r) for rs in plist for r in rs)
            feat = bytearray()
            field_varint(1, bid, feat)
            field_bytes(2, packed([0, values.index(kind)]), feat)
            field_varint(3, 0, feat)
            field_bytes(4, packed(g.cmds), feat)
            features.append(feat)

    layer = bytearray()
    field_varint(15, 2, layer)
    field_bytes(1, b"buildings3d", layer)
    for f in features:
        field_bytes(2, f, layer)
    for k in keys:
        field_bytes(3, k.encode(), layer)
    for v in values:
        val = bytearray()
        field_bytes(1, v.encode(), val)
        field_bytes(4, val, layer)
    field_varint(5, EXTENT, layer)
    tile = bytearray()
    field_bytes(3, layer, tile)
    return bytes(tile), stats


def tile_lonlat(x, y, z):
    n = 2**z
    lon = x / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def main(src, dst):
    tiles = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    with open(src) as f:
        for line in f:
            r = json.loads(line)
            tiles[(r["tx"], r["ty"])][r["b"]][r["k"]].append((r["tx"], r["ty"], r["g"]))

    encoded = []
    for (tx, ty), buildings in sorted(tiles.items()):
        raw, stats = encode_tile(buildings)
        gz = gzip.compress(raw, 9)
        encoded.append((zxy_to_tileid(Z, tx, ty), gz))
        print(f"{Z}/{tx}/{ty}: {len(buildings)} buildings, {dict(stats)}, "
              f"raw {len(raw)/1024:.0f} KB, gzip {len(gz)/1024:.0f} KB, "
              f"{len(raw)/max(stats['vertices'],1):.2f} B/vertex")

    xs = [t[0] for t in tiles]
    ys = [t[1] for t in tiles]
    w, n = tile_lonlat(min(xs), min(ys), Z)
    e, s = tile_lonlat(max(xs) + 1, max(ys) + 1, Z)
    with open(dst, "wb") as f:
        writer = Writer(f)
        for tid, data in sorted(encoded):
            writer.write_tile(tid, data)
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": Z,
                "max_zoom": Z,
                "min_lon_e7": int(w * 1e7),
                "min_lat_e7": int(s * 1e7),
                "max_lon_e7": int(e * 1e7),
                "max_lat_e7": int(n * 1e7),
                "center_zoom": Z,
                "center_lon_e7": int((w + e) / 2 * 1e7),
                "center_lat_e7": int((s + n) / 2 * 1e7),
            },
            {
                "name": "vienna-lod2-3d",
                "attribution": "Stadt Wien – data.wien.gv.at (CC BY 4.0)",
                "vector_layers": [
                    {"id": "buildings3d", "description": "3D MVT: xyz deltas, z in dm, header bbox ring",
                     "minzoom": Z, "maxzoom": Z, "fields": {"type": "String"}}
                ],
            },
        )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
