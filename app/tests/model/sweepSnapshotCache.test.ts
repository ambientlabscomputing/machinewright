/**
 * `SweepSnapshotCache` covers RFD-19 M3's "load graph and geometry snapshots
 * for selected evaluation points" and its "scrubbing among cached points is
 * a local application interaction" requirement — no worker round trip, and
 * critically, no dependence on `SnapshotStore`'s monotonic compute-time
 * generation (see the module's own doc comment for why that would silently
 * break scrubbing backward through a sweep).
 */
import { describe, expect, it } from "vitest";
import { SweepSnapshotCache, type SweepInstallerPort } from "../../src/model/SweepSnapshotCache";
import type { SweepPointResult } from "../../src/evaluator/SweepCoordinator";
import type { CacheClient } from "../../src/cache/CacheClient";
import type { EvaluationSnapshot } from "../../src/model/generated/EvaluationSnapshot";

function makeRaw(pointIndex: number): EvaluationSnapshot {
  return {
    generation: pointIndex + 1,
    graph_digest: `graph-${pointIndex}`,
    artifact_manifest_digest: `manifest-${pointIndex}`,
    graph: { root_id: "root", nodes: [] },
    meshes: [],
    observables: [],
    provenance: {
      asset_digest: "sha256:asset",
      environment_digest: "sha256:env",
      input_digest: "sha256:input",
      machinewright_version: "0.2.0",
      project_source_digest: "sha256:project",
      python_version: "3.13.0",
      template_id: "machinewright.reference.simple",
      template_source_digest: "sha256:template",
      template_version: "1.0.0",
    },
  };
}

function makeResult(pointIndex: number): SweepPointResult {
  return {
    pointIndex,
    snapshotPath: `/tmp/sweep/point-${String(pointIndex).padStart(4, "0")}/evaluation-snapshot.json`,
    graphDigest: `graph-${pointIndex}`,
    artifactManifestDigest: `manifest-${pointIndex}`,
  };
}

function makeFakeCacheClient(): CacheClient & { readonly resolveCalls: string[] } {
  const resolveCalls: string[] = [];
  return {
    resolveCalls,
    resolveMeshRefs: async (outputDirectory: string) => {
      resolveCalls.push(outputDirectory);
      return [];
    },
  } as unknown as CacheClient & { readonly resolveCalls: string[] };
}

function makeFakeInstaller(): SweepInstallerPort & {
  readonly calls: Array<{ generation: bigint; artifactManifestDigest: string }>;
} {
  const calls: Array<{ generation: bigint; artifactManifestDigest: string }> = [];
  return {
    calls,
    stagePreloaded(generation, _raw, _meshes, artifactManifestDigest) {
      calls.push({ generation, artifactManifestDigest });
    },
  };
}

describe("SweepSnapshotCache", () => {
  it("caches a completed point once and reports it present via has()", async () => {
    const cache = new SweepSnapshotCache({
      installer: makeFakeInstaller(),
      cacheClient: makeFakeCacheClient(),
      loadEvaluationSnapshot: async (path) => makeRaw(Number(path.match(/point-(\d+)/)?.[1] ?? 0)),
    });
    expect(cache.has(1n, 3)).toBe(false);
    await cache.cachePoint(1n, makeResult(3));
    expect(cache.has(1n, 3)).toBe(true);
    expect(cache.has(1n, 4)).toBe(false); // a different point never cached
    expect(cache.has(2n, 3)).toBe(false); // a different sweep id never cached
  });

  it("selectPoint() installs a cached point under a fresh, ever-increasing view generation — never its compute-time generation", async () => {
    const installer = makeFakeInstaller();
    const cache = new SweepSnapshotCache({
      installer,
      cacheClient: makeFakeCacheClient(),
      loadEvaluationSnapshot: async (path) => makeRaw(Number(path.match(/point-(\d+)/)?.[1] ?? 0)),
    });
    await cache.cachePoint(1n, makeResult(5)); // compute-time generation would be 6
    await cache.cachePoint(1n, makeResult(2)); // compute-time generation would be 3

    expect(cache.selectPoint(1n, 5)).toBe(true);
    expect(cache.selectPoint(1n, 2)).toBe(true); // scrubbing "backward" from point 5 to point 2

    // Both selections must install successfully in view order, regardless of
    // the points' own compute-time generations (6 then 3) — a monotonic
    // guard keyed on those would have rejected the second install.
    expect(installer.calls.map((call) => call.generation)).toEqual([1n, 2n]);
    expect(installer.calls[1]?.artifactManifestDigest).toBe("manifest-2");
  });

  it("selectPoint() returns false for a point that was never cached", () => {
    const cache = new SweepSnapshotCache({
      installer: makeFakeInstaller(),
      cacheClient: makeFakeCacheClient(),
      loadEvaluationSnapshot: async () => makeRaw(0),
    });
    expect(cache.selectPoint(1n, 0)).toBe(false);
  });

  it("clear() drops every cached point", async () => {
    const cache = new SweepSnapshotCache({
      installer: makeFakeInstaller(),
      cacheClient: makeFakeCacheClient(),
      loadEvaluationSnapshot: async () => makeRaw(0),
    });
    await cache.cachePoint(1n, makeResult(0));
    expect(cache.has(1n, 0)).toBe(true);
    cache.clear();
    expect(cache.has(1n, 0)).toBe(false);
  });

  it("resolves each point's meshes against that point's own snapshot directory, not a shared sweep-wide one", async () => {
    // Regression test: each sweep point writes its own `meshes/` subfolder
    // under its own `point-XXXX` directory (evaluate_sweep_point in
    // evaluation.py), not under one directory shared by the whole sweep.
    // Passing any single directory in from the caller previously resolved
    // to a mesh file that didn't exist there, surfacing at runtime as
    // "Failed to read mesh file: ...".
    const cacheClient = makeFakeCacheClient();
    const cache = new SweepSnapshotCache({
      installer: makeFakeInstaller(),
      cacheClient,
      loadEvaluationSnapshot: async () => makeRaw(7),
    });
    await cache.cachePoint(1n, makeResult(7));
    expect(cacheClient.resolveCalls).toEqual(["/tmp/sweep/point-0007"]);
  });
});
