/**
 * LSP base-protocol framing (`Content-Length: N\r\n\r\n<utf-8 json>`) for
 * a Node-based test harness — mirrors the exact same parsing logic
 * implemented in Swift (macos/MachinewrightApp-macOS/MachinewrightLspModule.swift),
 * so the wire-format understanding itself can be verified against a real
 * `pylsp` process from a fast Node contract test, independent of the
 * native bridge (see tests/editor/lsp-roundtrip.test.ts) — the same
 * "verify the protocol/process behavior directly, then trust the native
 * bridge to relay it" split already used for the worker protocol
 * (app/src/protocol/worker/framing.ts + tests/protocol/worker-roundtrip.test.ts).
 */

export function encodeLspFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf-8");
  return Buffer.concat([header, body]);
}

export class LspFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) break;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
      messages.push(JSON.parse(body));
      this.buffer = this.buffer.subarray(bodyEnd);
    }
    return messages;
  }
}
