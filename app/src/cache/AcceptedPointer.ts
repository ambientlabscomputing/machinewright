/**
 * The R11 fix (deleted Rust UI review: "cache publication and source
 * capture are not one accepted revision... a newer edit during that
 * interval can leave a superseded result in the durable pointer even though
 * the UI rejects it"). Two independent halves:
 *
 * 1. `InProcessAcceptedPointer` — the in-memory monotonic guard covering the
 *    actual completion-ordering race. `model/SnapshotStore.install()` uses
 *    exactly this guard as its one gate before mutating `accepted`.
 * 2. `PersistedAcceptedPointer` — a port for the on-disk "last known good"
 *    pointer, written via a native atomic temp-file-then-rename primitive
 *    (a small addition to the native assets module, landing in Phase 2 of
 *    the M2 plan) so a restart can restore last-known-good without ever
 *    observing a half-written pointer file. Left as an injectable port here
 *    so the in-process guard is fully testable before that native piece
 *    exists.
 */

export interface AcceptedRevision {
  readonly generation: bigint;
  readonly graphDigest: string;
  readonly artifactManifestDigest: string;
}

export class InProcessAcceptedPointer {
  private lastInstalledGeneration = -1n;

  /** True if `candidate` is newer than whatever was last accepted; only then should a caller proceed to install it. */
  canInstall(candidateGeneration: bigint): boolean {
    return candidateGeneration > this.lastInstalledGeneration;
  }

  /** Records `candidateGeneration` as accepted. Callers must only call this after `canInstall` returned true for the same generation, in the same synchronous step. */
  markInstalled(candidateGeneration: bigint): void {
    this.lastInstalledGeneration = candidateGeneration;
  }

  getLastInstalledGeneration(): bigint {
    return this.lastInstalledGeneration;
  }
}

export interface PersistedAcceptedPointerPort {
  writeAtomically(projectRoot: string, revision: AcceptedRevision): Promise<void>;
  read(projectRoot: string): Promise<AcceptedRevision | null>;
}
