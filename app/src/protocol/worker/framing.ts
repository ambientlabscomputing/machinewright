/**
 * Length-delimited framing matching the Python worker's wire format exactly
 * (src/machinewright/worker.py: `read_request` / `EventWriter`): a 4-byte
 * little-endian length prefix followed by a serialized protobuf message.
 *
 * This module is transport-agnostic (it operates on byte buffers) so it can
 * be reused by both a Node-based test harness and, later, the native macOS
 * bridge that owns the actual worker subprocess's stdio pipes.
 */

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, /* littleEndian */ true);
  frame.set(payload, 4);
  return frame;
}

/**
 * Incrementally accumulates bytes and yields complete frame payloads as
 * they become available, matching Python's `_read_exact` blocking-read
 * semantics for a streaming (non-blocking) Node transport.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const size = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        4,
      ).getUint32(0, /* littleEndian */ true);
      if (this.buffer.length < 4 + size) break;
      frames.push(this.buffer.slice(4, 4 + size));
      this.buffer = this.buffer.slice(4 + size);
    }
    return frames;
  }
}
