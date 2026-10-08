// Usage: node scripts/buildings/inspect-pmtiles.mjs <file.pmtiles> <lng> <lat>
/* global process, console */
import { readFile } from 'node:fs/promises';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { PMTiles } from 'pmtiles';

const [file, lng, lat] = process.argv.slice(2);
const bytes = await readFile(file);
const source = {
  getKey: () => file,
  getBytes: async (offset, length) => ({
    data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length),
  }),
};
const z = 15;
const x = Math.floor(((+lng + 180) / 360) * 2 ** z);
const r = (+lat * Math.PI) / 180;
const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
const tile = await new PMTiles(source).getZxy(z, x, y);
const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers.building;
let withId = 0;
const shapes = {};
for (let i = 0; i < layer.length; i++) {
  const f = layer.feature(i);
  if (f.id !== undefined) withId++;
  const s = f.properties.roof_shape;
  if (s) shapes[s] = (shapes[s] ?? 0) + 1;
}
console.log({ features: layer.length, withId, shapes });
