import { describe, expect, it } from "vitest";
import { isStaleGeneration, isNewerGeneration } from "../../src/protocol/surfaces/version";
import type { ViewportHostCommand, ViewportSurfaceEvent } from "../../src/protocol/surfaces/viewport";

/**
 * A minimal viewport-side reducer standing in for the WebView's real
 * generation-gating logic, exercising the exact scenario named in the
 * deleted Rust UI's review finding R7 ("done when: ... a commitSnapshot
 * for generation N is rejected once generation N+1 has already
 * committed").
 */
function reduceViewport(
  committed: bigint,
  command: ViewportHostCommand,
): { committed: bigint; events: ViewportSurfaceEvent[] } {
  if (command.kind === "commitSnapshot") {
    if (isStaleGeneration(committed, command.generation)) {
      return { committed, events: [] };
    }
    return { committed: command.generation, events: [{ kind: "prepared", generation: command.generation }] };
  }
  return { committed, events: [] };
}

describe("isStaleGeneration / isNewerGeneration", () => {
  it("treats a lower generation as stale", () => {
    expect(isStaleGeneration(5n, 3n)).toBe(true);
    expect(isStaleGeneration(5n, 5n)).toBe(false);
    expect(isStaleGeneration(5n, 6n)).toBe(false);
  });

  it("treats a higher generation as newer", () => {
    expect(isNewerGeneration(5n, 6n)).toBe(true);
    expect(isNewerGeneration(5n, 5n)).toBe(false);
    expect(isNewerGeneration(5n, 4n)).toBe(false);
  });
});

describe("viewport snapshot promotion (R7 regression)", () => {
  it("rejects a commit for an older generation than what is already committed", () => {
    const afterFirst = reduceViewport(0n, { kind: "commitSnapshot", generation: 42n });
    expect(afterFirst.committed).toBe(42n);

    const afterNewer = reduceViewport(afterFirst.committed, {
      kind: "commitSnapshot",
      generation: 43n,
    });
    expect(afterNewer.committed).toBe(43n);

    // Generation 42's own eventual (delayed) commit arrives after 43 already
    // won the race — it must not roll the committed snapshot backwards.
    const staleArrivesLate = reduceViewport(afterNewer.committed, {
      kind: "commitSnapshot",
      generation: 42n,
    });
    expect(staleArrivesLate.committed).toBe(43n);
    expect(staleArrivesLate.events).toEqual([]);
  });
});
