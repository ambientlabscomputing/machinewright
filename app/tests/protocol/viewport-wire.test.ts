import { describe, expect, it } from "vitest";
import {
  serializeViewportHostCommand,
  deserializeViewportHostCommand,
  serializeViewportSurfaceEvent,
  deserializeViewportSurfaceEvent,
} from "../../src/protocol/surfaces/viewport";

// Beyond Number.MAX_SAFE_INTEGER — same precision probe used for the
// worker protocol (tests/protocol/worker-roundtrip.test.ts): proves the
// postMessage JSON boundary doesn't silently truncate a real generation id.
const PRECISION_PROBE_GENERATION = 9007199254740993n;

describe("ViewportHostCommand wire (de)serialization", () => {
  it("round-trips generation losslessly through JSON for prepareSnapshot", () => {
    const command = serializeViewportHostCommand({
      kind: "prepareSnapshot",
      generation: PRECISION_PROBE_GENERATION,
      artifactManifestDigest: "sha256:abc",
      meshes: [{ graphNodeId: "n1", digest: "sha256:def", url: "file:///tmp/a.mwm" }],
    });
    // Confirms the actual wire bytes carry a string, not a JSON number
    // (which would already have lost precision at serialization time).
    expect(command).toContain(`"generation":"${PRECISION_PROBE_GENERATION}"`);

    const decoded = deserializeViewportHostCommand(command);
    expect(decoded.kind).toBe("prepareSnapshot");
    if (decoded.kind !== "prepareSnapshot") throw new Error("unreachable");
    expect(decoded.generation).toBe(PRECISION_PROBE_GENERATION);
    expect(typeof decoded.generation).toBe("bigint");
  });

  it("round-trips fitCamera, which carries no generation", () => {
    const command = serializeViewportHostCommand({ kind: "fitCamera" });
    expect(deserializeViewportHostCommand(command)).toEqual({ kind: "fitCamera" });
  });

  it("round-trips benchmarkSynthetic, which carries no generation", () => {
    const command = serializeViewportHostCommand({ kind: "benchmarkSynthetic", triangleCount: 100_000 });
    expect(deserializeViewportHostCommand(command)).toEqual({
      kind: "benchmarkSynthetic",
      triangleCount: 100_000,
    });
  });
});

describe("ViewportSurfaceEvent wire (de)serialization", () => {
  it("round-trips generation losslessly for pickResult", () => {
    const event = serializeViewportSurfaceEvent({
      kind: "pickResult",
      generation: PRECISION_PROBE_GENERATION,
      graphNodeId: "n1",
      geometryEntityId: null,
    });
    const decoded = deserializeViewportSurfaceEvent(event);
    expect(decoded.kind).toBe("pickResult");
    if (decoded.kind !== "pickResult") throw new Error("unreachable");
    expect(decoded.generation).toBe(PRECISION_PROBE_GENERATION);
  });

  it("round-trips generation-less events (ready, contextLost, contextRestored)", () => {
    for (const event of [{ kind: "ready" }, { kind: "contextLost" }, { kind: "contextRestored" }] as const) {
      expect(deserializeViewportSurfaceEvent(serializeViewportSurfaceEvent(event))).toEqual(event);
    }
  });

  it("round-trips benchmarkResult, which carries no generation", () => {
    const event = serializeViewportSurfaceEvent({
      kind: "benchmarkResult",
      triangleCount: 1_000_000,
      fps: 59.94,
      frames: 180,
      durationMs: 3003,
    });
    expect(deserializeViewportSurfaceEvent(event)).toEqual({
      kind: "benchmarkResult",
      triangleCount: 1_000_000,
      fps: 59.94,
      frames: 180,
      durationMs: 3003,
    });
  });
});
