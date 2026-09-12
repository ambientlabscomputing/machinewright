import { describe, expect, it } from "vitest";
import { parseMwm } from "../../web/viewport/src/mwm";

/** Hand-encodes a .mwm2 buffer the same way evaluation.py's _write_meshes does. */
function encodeMwm(
  positions: readonly [number, number, number][],
  normals: readonly [number, number, number][],
  triangles: readonly [number, number, number][],
  bounds: readonly [number, number, number, number, number, number],
): ArrayBuffer {
  const byteLength = 4 + 8 + 24 + positions.length * 24 + triangles.length * 12;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set([..."MWM2"].map((c) => c.charCodeAt(0)));
  view.setUint32(4, positions.length, true);
  view.setUint32(8, triangles.length, true);
  for (let i = 0; i < 6; i++) view.setFloat32(12 + i * 4, bounds[i]!, true);
  let offset = 36;
  for (let i = 0; i < positions.length; i++) {
    const [px, py, pz] = positions[i]!;
    const [nx, ny, nz] = normals[i]!;
    view.setFloat32(offset, px, true);
    view.setFloat32(offset + 4, py, true);
    view.setFloat32(offset + 8, pz, true);
    view.setFloat32(offset + 12, nx, true);
    view.setFloat32(offset + 16, ny, true);
    view.setFloat32(offset + 20, nz, true);
    offset += 24;
  }
  for (const [a, b, c] of triangles) {
    view.setUint32(offset, a, true);
    view.setUint32(offset + 4, b, true);
    view.setUint32(offset + 8, c, true);
    offset += 12;
  }
  return buffer;
}

describe("parseMwm", () => {
  it("parses a single-triangle mesh matching evaluation.py's _write_meshes layout", () => {
    const positions: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const normals: [number, number, number][] = [
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ];
    const triangles: [number, number, number][] = [[0, 1, 2]];
    const bounds: [number, number, number, number, number, number] = [0, 0, 0, 1, 1, 0];

    const buffer = encodeMwm(positions, normals, triangles, bounds);
    const parsed = parseMwm(buffer);

    expect(Array.from(parsed.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(parsed.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(parsed.indices)).toEqual([0, 1, 2]);
    expect(parsed.bounds).toEqual([0, 0, 0, 1, 1, 0]);
  });

  it("rejects a buffer with the wrong magic", () => {
    const buffer = new ArrayBuffer(36);
    new Uint8Array(buffer, 0, 4).set([..."NOPE"].map((c) => c.charCodeAt(0)));
    expect(() => parseMwm(buffer)).toThrow(/Not a MWM2 mesh/);
  });
});
