/**
 * R5/R7 regression: `SnapshotStore` is the single owner of "accepted", is
 * monotonic, and — most importantly — has no way to blank a previously
 * accepted snapshot. See SnapshotStore.ts's doc comment for the findings.
 */
import { describe, expect, it } from "vitest";
import { SnapshotStore } from "../../src/model/SnapshotStore";
import type { ProjectSnapshot } from "../../src/model/ProjectSnapshot";
import { EMPTY_EVIDENCE_INDEX } from "../../src/model/ProjectSnapshot";

function makeSnapshot(generation: bigint): ProjectSnapshot {
  return {
    generation,
    graphDigest: `graph-${generation}`,
    artifactManifestDigest: `manifest-${generation}`,
    graph: { root_id: "root", nodes: [] },
    sourceMap: [],
    geometry: [],
    diagnostics: [],
    observables: [],
    evidence: EMPTY_EVIDENCE_INDEX,
  };
}

describe("SnapshotStore", () => {
  it("installs the first snapshot unconditionally", () => {
    const store = new SnapshotStore();
    expect(store.install(makeSnapshot(1n))).toBe(true);
    expect(store.getAccepted()?.generation).toBe(1n);
  });

  it("R7: refuses to install a generation older than or equal to the currently accepted one", () => {
    const store = new SnapshotStore();
    store.install(makeSnapshot(5n));
    expect(store.install(makeSnapshot(3n))).toBe(false);
    expect(store.install(makeSnapshot(5n))).toBe(false);
    expect(store.getAccepted()?.generation).toBe(5n); // unchanged by the rejected attempts
  });

  it("R7: installs a strictly newer generation and replaces the accepted value", () => {
    const store = new SnapshotStore();
    store.install(makeSnapshot(1n));
    expect(store.install(makeSnapshot(2n))).toBe(true);
    expect(store.getAccepted()?.generation).toBe(2n);
  });

  it("R5: a failure sets status but never clears the previously accepted snapshot", () => {
    const store = new SnapshotStore();
    store.install(makeSnapshot(1n));
    store.setFailed(2n, { generation: 2n, code: "e", message: "boom", traceback: "", diagnosticsJson: new Uint8Array(0) });

    expect(store.getAccepted()?.generation).toBe(1n); // still last-known-good
    expect(store.getStatus()).toMatchObject({ kind: "failed", generation: 2n });
  });

  it("R5: worker-unhealthy status never clears the previously accepted snapshot", () => {
    const store = new SnapshotStore();
    store.install(makeSnapshot(1n));
    store.setWorkerUnhealthy();

    expect(store.getAccepted()?.generation).toBe(1n);
    expect(store.getStatus()).toEqual({ kind: "worker_unhealthy" });
  });

  it("ignores a stale failure for a generation older than what is already accepted", () => {
    const store = new SnapshotStore();
    store.install(makeSnapshot(5n));
    store.setFailed(3n, { generation: 3n, code: "e", message: "stale", traceback: "", diagnosticsJson: new Uint8Array(0) });
    expect(store.getStatus()).toEqual({ kind: "idle" });
  });

  it("notifies subscribers on install, pending, and failure transitions", () => {
    const store = new SnapshotStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));

    store.setPending(1n);
    store.install(makeSnapshot(1n));
    store.setFailed(2n, { generation: 2n, code: "e", message: "m", traceback: "", diagnosticsJson: new Uint8Array(0) });

    expect(notifications).toBe(3);
  });
});
