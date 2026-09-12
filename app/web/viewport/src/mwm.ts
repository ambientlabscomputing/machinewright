/**
 * Parser for the `.mwm2` mesh binary format
 * (src/machinewright/evaluation.py's `_write_meshes`): magic "MWM2" (4
 * bytes), uint32 vertex_count + uint32 triangle_count, 6 float32 bounds,
 * then `vertex_count` interleaved [position(3), normal(3)] float32
 * records, then `triangle_count` uint32-triple index records. All
 * little-endian, matching Python's `struct.pack("<...")` calls.
 *
 * No Python-side change was needed for B.4 — this format was already
 * stable and covered by tests/test_rfd19_evaluation.py.
 */

export interface ParsedMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: readonly [number, number, number, number, number, number];
}

const MAGIC = "MWM2";

export function parseMwm(buffer: ArrayBuffer): ParsedMesh {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) {
    throw new Error(`Not a ${MAGIC} mesh (got magic ${JSON.stringify(magic)})`);
  }
  const vertexCount = view.getUint32(4, true);
  const triangleCount = view.getUint32(8, true);
  const bounds = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
  ] as const;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let offset = 36;
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = view.getFloat32(offset, true);
    positions[i * 3 + 1] = view.getFloat32(offset + 4, true);
    positions[i * 3 + 2] = view.getFloat32(offset + 8, true);
    normals[i * 3] = view.getFloat32(offset + 12, true);
    normals[i * 3 + 1] = view.getFloat32(offset + 16, true);
    normals[i * 3 + 2] = view.getFloat32(offset + 20, true);
    offset += 24;
  }

  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount; i++) {
    indices[i * 3] = view.getUint32(offset, true);
    indices[i * 3 + 1] = view.getUint32(offset + 4, true);
    indices[i * 3 + 2] = view.getUint32(offset + 8, true);
    offset += 12;
  }

  return { positions, normals, indices, bounds };
}
