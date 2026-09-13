/**
 * Orchestrates the prepare/ready/commit exchange (protocol/surfaces/
 * viewport.ts) between a completed evaluation and the one accepted
 * `SnapshotStore`. This is what actually calls `SnapshotStore.install()` —
 * the only call site that does, per that module's R7 discussion — after
 * the viewport WebView has staged the new generation's geometry and
 * acknowledged it is ready, never before.
 *
 * `ViewportSurfacePort` abstracts the WebView `postMessage` boundary so this
 * class is testable without React Native or a real WebView: production
 * wiring (Phase 4 of the M2 plan) implements it against `ViewportHost`'s
 * `postMessage`/`onMessage`; tests use a fake that resolves "prepared"
 * immediately or on demand.
 */
import type { EvaluationResult } from "./EvaluationCoordinator";
import type { ArtifactManifest } from "../cache/ArtifactManifest";
import type { CacheClient } from "../cache/CacheClient";
import type { SnapshotStore } from "../model/SnapshotStore";
import { buildProjectSnapshot } from "../model/ProjectSnapshot";
import { fromEvaluationDiagnostics } from "../model/Diagnostics";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import type { ViewportSurfaceEvent } from "../protocol/surfaces/viewport";

export interface ViewportSurfacePort {
  prepareSnapshot(command: {
    generation: bigint;
    artifactManifestDigest: string;
    meshes: readonly { graphNodeId: string; digest: string; url: string }[];
  }): void;
  commitSnapshot(generation: bigint): void;
  discardSnapshot(generation: bigint): void;
  onEvent(listener: (event: ViewportSurfaceEvent) => void): () => void;
}

export interface SnapshotInstallerOptions {
  readonly viewport: ViewportSurfacePort;
  readonly snapshotStore: SnapshotStore;
  readonly cacheClient: CacheClient;
  readonly loadEvaluationSnapshot: (snapshotPath: string) => Promise<EvaluationSnapshot>;
}

export class SnapshotInstaller {
  private readonly viewport: ViewportSurfacePort;
  private readonly snapshotStore: SnapshotStore;
  private readonly cacheClient: CacheClient;
  private readonly loadEvaluationSnapshot: (snapshotPath: string) => Promise<EvaluationSnapshot>;
  private readonly unsubscribeViewport: () => void;
  private readonly pendingRaw = new Map<bigint, EvaluationSnapshot>();
  private readonly pendingMeshes = new Map<bigint, readonly { graphNodeId: string; digest: string; url: string }[]>();

  constructor(options: SnapshotInstallerOptions) {
    this.viewport = options.viewport;
    this.snapshotStore = options.snapshotStore;
    this.cacheClient = options.cacheClient;
    this.loadEvaluationSnapshot = options.loadEvaluationSnapshot;
    this.unsubscribeViewport = this.viewport.onEvent((event) => this.handleViewportEvent(event));
  }

  /** Begins staging a completed evaluation's geometry; installs only once the viewport acknowledges "prepared". */
  async stage(result: EvaluationResult, outputDirectory: string): Promise<void> {
    this.snapshotStore.setPending(result.generation);
    const raw = await this.loadEvaluationSnapshot(result.snapshotPath);
    const manifest: ArtifactManifest = { artifactManifestDigest: result.artifactManifestDigest, meshes: raw.meshes ?? [] };
    const meshes = await this.cacheClient.resolveMeshRefs(outputDirectory, manifest);
    // Stash raw/meshes for use once "prepared" arrives.
    this.pendingRaw.set(result.generation, raw);
    this.pendingMeshes.set(result.generation, meshes);
    this.viewport.prepareSnapshot({
      generation: result.generation,
      artifactManifestDigest: result.artifactManifestDigest,
      meshes,
    });
  }

  dispose(): void {
    this.unsubscribeViewport();
  }

  private handleViewportEvent(event: ViewportSurfaceEvent): void {
    if (event.kind === "prepared") {
      const raw = this.pendingRaw.get(event.generation);
      const meshes = this.pendingMeshes.get(event.generation);
      this.pendingRaw.delete(event.generation);
      this.pendingMeshes.delete(event.generation);
      if (raw === undefined || meshes === undefined) return; // not ours (or already superseded/discarded)

      const snapshot = buildProjectSnapshot({
        generation: event.generation,
        raw,
        geometry: meshes,
        diagnostics: fromEvaluationDiagnostics(raw.diagnostics ?? []),
      });
      const installed = this.snapshotStore.install(snapshot);
      if (installed) {
        this.viewport.commitSnapshot(event.generation);
      } else {
        // A newer generation already won the race — never commit a
        // superseded one, matching the monotonic guard in SnapshotStore.
        this.viewport.discardSnapshot(event.generation);
      }
      return;
    }
    if (event.kind === "prepareFailed") {
      this.pendingRaw.delete(event.generation);
      this.pendingMeshes.delete(event.generation);
      // Never blank `accepted` — only the status changes, per SnapshotStore's R5 contract.
      this.snapshotStore.setFailed(event.generation, {
        generation: event.generation,
        code: "viewport_prepare_failed",
        message: event.reason,
        traceback: "",
        diagnosticsJson: new Uint8Array(0),
      });
    }
  }
}
