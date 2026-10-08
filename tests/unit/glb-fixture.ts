/** Builds a minimal binary glTF (one node + mesh per entry, one named material each). */
export function makeGlb(meshes: { material: string; positions: number[] }[]): Uint8Array {
  const chunks: Float32Array[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const gltfMeshes: object[] = [];
  const materials: object[] = [];
  let offset = 0;
  meshes.forEach((m, i) => {
    const arr = new Float32Array(m.positions);
    chunks.push(arr);
    const min = [0, 1, 2].map((k) => Math.min(...m.positions.filter((_, j) => j % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...m.positions.filter((_, j) => j % 3 === k)));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: arr.byteLength });
    accessors.push({
      bufferView: i,
      componentType: 5126,
      count: arr.length / 3,
      type: 'VEC3',
      min,
      max,
    });
    materials.push({ name: m.material, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });
    gltfMeshes.push({ primitives: [{ attributes: { POSITION: i }, material: i }] });
    offset += arr.byteLength;
  });
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((_, i) => ({ mesh: i })),
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, offset, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  let p = binStart + 8;
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer), p);
    p += c.byteLength;
  }
  return out;
}
