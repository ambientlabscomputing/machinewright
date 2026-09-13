/**
 * Caches a sweep's completed points' evaluation snapshots and geometry so
 * selecting a point in the behavior lab ("load graph and geometry snapshots
 * for selected evaluation points", RFD-19 M3) never re-runs Python and never
 * refetches meshes already resolved once.
 *
 * Deliberately does not extend or replace `SnapshotStore` — that store is a
 * single-owner, monotonic-generation "the accepted project snapshot" by
 * design (see its own doc comment). Holding N snapshots (one per sweep
 * point) is a different concern, so it lives here instead. Viewing a cached
 * point still goes through `SnapshotStore`/`SnapshotInstaller` unchanged:
 * `selectPoint()` calls `SnapshotInstaller.stagePreloaded()` under a fresh,
 * ever-increasing "view generation" this class owns, which is installed the
 * same way any other accepted snapshot would be. Neither the viewport nor
 * the graph view need any notion of "sweep mode."
 */
import type { CacheClient } from "../cache/CacheClient";
import type { ArtifactManifest, MeshRefLite } from "../cache/ArtifactManifest";
import type { SweepPointResult } from "../evaluator/SweepCoordinator";
import type { EvaluationSnapshot } from "./generated/EvaluationSnapshot";

interface CachedPoint {
  readonly raw: EvaluationSnapshot;
  readonly meshes: readonly MeshRefLite[];
  readonly artifactManifestDigest: string;
}

/** The one `SnapshotInstaller` method this cache needs, as a port — matches
 * `SnapshotInstaller.stagePreloaded` structurally, so a real installer is a
 * valid `SweepInstallerPort` with no adapter, while tests can pass a plain
 * fake instead of a real `SnapshotInstaller` (whose private fields would
 * otherwise make it non-fakeable via a plain object literal). */
export interface SweepInstallerPort {
  stagePreloaded(
    generation: bigint,
    raw: EvaluationSnapshot,
    meshes: readonly MeshRefLite[],
    artifactManifestDigest: string,
  ): void;
}

export interface SweepSnapshotCacheOptions {
  readonly installer: SweepInstallerPort;
  readonly cacheClient: CacheClient;
  readonly loadEvaluationSnapshot: (snapshotPath: string) => Promise<EvaluationSnapshot>;
}

function key(sweepId: bigint, pointIndex: number): string {
  return `${sweepId}:${pointIndex}`;
}

/** The directory a mesh's relative `name` (e.g. `meshes/<digest>.mwm`) is
 * joined against, per `CacheClient.resolveMeshRefs`. Each sweep point
 * writes its own `meshes/` subfolder under its own `point-XXXX` directory
 * (see `evaluate_sweep_point` in evaluation.py) — there is no single
 * sweep-wide output directory meshes live under, so this must always be
 * derived from that specific point's own `snapshotPath`, never passed in
 * by the caller (a wrong shared directory silently resolves to a mesh file
 * that doesn't exist there). */
function pointOutputDirectory(snapshotPath: string): string {
  const lastSlash = snapshotPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : snapshotPath.slice(0, lastSlash);
}

export class SweepSnapshotCache {
  private readonly installer: SweepInstallerPort;
  private readonly cacheClient: CacheClient;
  private readonly loadEvaluationSnapshot: (snapshotPath: string) => Promise<EvaluationSnapshot>;
  private readonly cache = new Map<string, CachedPoint>();
  private viewGeneration = 0n;

  constructor(options: SweepSnapshotCacheOptions) {
    this.installer = options.installer;
    this.cacheClient = options.cacheClient;
    this.loadEvaluationSnapshot = options.loadEvaluationSnapshot;
  }

  /** Loads and resolves a completed sweep point's snapshot once, ahead of any selection. */
  async cachePoint(sweepId: bigint, result: SweepPointResult): Promise<void> {
    const raw = await this.loadEvaluationSnapshot(result.snapshotPath);
    const manifest: ArtifactManifest = {
      artifactManifestDigest: result.artifactManifestDigest,
      meshes: raw.meshes ?? [],
    };
    const meshes = await this.cacheClient.resolveMeshRefs(pointOutputDirectory(result.snapshotPath), manifest);
    this.cache.set(key(sweepId, result.pointIndex), {
      raw,
      meshes,
      artifactManifestDigest: result.artifactManifestDigest,
    });
  }

  has(sweepId: bigint, pointIndex: number): boolean {
    return this.cache.has(key(sweepId, pointIndex));
  }

  /** Installs a cached point's snapshot for viewing/scrubbing. Returns false if that point isn't cached (not yet evaluated, or superseded and dropped). */
  selectPoint(sweepId: bigint, pointIndex: number): boolean {
    const cached = this.cache.get(key(sweepId, pointIndex));
    if (cached === undefined) return false;
    this.viewGeneration += 1n;
    this.installer.stagePreloaded(
      this.viewGeneration,
      cached.raw,
      cached.meshes,
      cached.artifactManifestDigest,
    );
    return true;
  }

  /** Drops every cached point — call when a new sweep starts, so a stale sweep's points can't be selected. */
  clear(): void {
    this.cache.clear();
  }
}
