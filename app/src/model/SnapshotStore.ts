/**
 * The single owner of "the accepted project snapshot" — the fix for the
 * deleted Rust UI's review findings R5 and R7.
 *
 * R7 ("snapshot installation has multiple owners"): `install()` is the
 * *only* method that ever mutates `accepted`, gated by the same monotonic
 * generation guard `cache/AcceptedPointer.InProcessAcceptedPointer`
 * implements. Every panel (viewport, graph, diagnostics) reads from this
 * one store rather than deriving its own notion of "current."
 *
 * R5 ("cached inspection depends on successful worker startup"): there is
 * deliberately **no `clear()` method**. A worker crash (see
 * evaluator/EvaluationCoordinator's `worker_unhealthy` health phase) can
 * only call `setStatus({kind: "worker_unhealthy"})` here — there is no
 * method it could call that would blank `accepted`. Inspection UI reads
 * `getAccepted()`, never worker-health state, so last-known-good geometry
 * and graph remain browsable through a crash.
 */
import type { EvaluationFailure } from "../evaluator/EvaluationCoordinator";
import type { ProjectSnapshot } from "./ProjectSnapshot";
import { InProcessAcceptedPointer } from "../cache/AcceptedPointer";

export type EvaluationStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly generation: bigint }
  | { readonly kind: "failed"; readonly generation: bigint; readonly failure: EvaluationFailure }
  | { readonly kind: "worker_unhealthy" };

export class SnapshotStore {
  private readonly pointer = new InProcessAcceptedPointer();
  private accepted: ProjectSnapshot | null = null;
  private status: EvaluationStatus = { kind: "idle" };
  private readonly listeners = new Set<() => void>();

  getAccepted(): ProjectSnapshot | null {
    return this.accepted;
  }

  getStatus(): EvaluationStatus {
    return this.status;
  }

  /** Installs `snapshot` if newer than whatever is currently accepted. Returns whether it was installed. */
  install(snapshot: ProjectSnapshot): boolean {
    if (!this.pointer.canInstall(snapshot.generation)) return false;
    this.pointer.markInstalled(snapshot.generation);
    this.accepted = snapshot;
    this.status = { kind: "idle" };
    this.notify();
    return true;
  }

  setPending(generation: bigint): void {
    this.status = { kind: "pending", generation };
    this.notify();
  }

  /** A failure only replaces `status`, never `accepted` — the last valid snapshot stays interactive alongside a visible failure indicator. */
  setFailed(generation: bigint, failure: EvaluationFailure): void {
    if (generation < this.pointer.getLastInstalledGeneration()) return; // stale failure, ignore
    this.status = { kind: "failed", generation, failure };
    this.notify();
  }

  setWorkerUnhealthy(): void {
    this.status = { kind: "worker_unhealthy" };
    this.notify();
  }

  clearStatus(): void {
    this.status = { kind: "idle" };
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
