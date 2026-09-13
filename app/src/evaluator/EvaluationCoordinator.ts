/**
 * Scheduling, debounce, cancellation, generation ordering, and worker
 * recovery — the policy layer `WorkerBridge.ts`'s own doc comment says
 * belongs here, not in the transport. This is the module that turns a bare
 * request/response worker transport into the "long-lived worker management"
 * RFD-19's M2 milestone calls for.
 *
 * Confirmed from reading src/machinewright/worker.py: the worker's command
 * queue is single-threaded and strictly FIFO — a second `EvaluateProject`
 * sent while one is running simply waits behind it rather than racing it.
 * `CancelEvaluation` is handled out-of-band by a reader thread flipping a
 * cooperative `CancellationToken` checked at discrete points inside
 * evaluation — i.e. cancellation is *advisory*, not synchronous. This
 * coordinator never assumes a cancelled evaluation stops immediately; it
 * relies entirely on the generation filter below to make a late,
 * uncancelled completion harmless.
 *
 * Findings from the deleted Rust UI's M2 review this directly addresses:
 *
 * - R4 ("Retry clears the error without recovering the worker"): `retry()`
 *   is the *only* transition out of `worker_unhealthy`, and it always both
 *   respawns a worker AND resends the last request as one call — there is
 *   no code path that clears the unhealthy state without also completing
 *   that resend.
 * - R7 (generation races / multiple snapshot owners): every incoming
 *   `WorkerEvent` is filtered once, at ingestion, against
 *   `event.generation < latestRequestedGeneration` — dropped unconditionally
 *   before any other state update runs. Regardless of how the advisory
 *   cancellation above actually resolved, a stale-generation completion can
 *   never reach a listener.
 */
import { create } from "@bufbuild/protobuf";
import {
  WorkerRequestSchema,
  type WorkerEvent,
} from "../protocol/worker/machinewright_worker_pb";
import type { WorkerTransport } from "./WorkerTransport";
import { boundedBackoff, type RetryPolicy } from "./RetryPolicy";

export interface SourceOverlayInput {
  readonly relativePath: string;
  readonly content: Uint8Array;
}

export interface EvaluationInput {
  readonly projectRoot: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly inputsJson: Uint8Array;
  readonly outputDirectory: string;
  readonly overlays: readonly SourceOverlayInput[];
  readonly environmentDigest: string;
}

export interface EvaluationResult {
  readonly generation: bigint;
  readonly snapshotPath: string;
  readonly graphDigest: string;
  readonly artifactManifestDigest: string;
  readonly evaluatedSources: ReadonlyArray<{ relativePath: string; digest: string }>;
}

export interface EvaluationFailure {
  readonly generation: bigint;
  readonly code: string;
  readonly message: string;
  readonly traceback: string;
  readonly diagnosticsJson: Uint8Array;
}

export type EvaluationOutcome =
  | { readonly kind: "completed"; readonly result: EvaluationResult }
  | { readonly kind: "failed"; readonly failure: EvaluationFailure }
  | { readonly kind: "cancelled"; readonly generation: bigint };

export type WorkerHealth =
  | { readonly phase: "no_worker" }
  | { readonly phase: "spawning" }
  | { readonly phase: "handshaking" }
  | { readonly phase: "idle"; readonly capabilities: readonly string[] }
  | { readonly phase: "evaluating"; readonly generation: bigint; readonly capabilities: readonly string[] }
  | { readonly phase: "worker_unhealthy"; readonly exitCode: number; readonly attempt: number };

export interface EvaluationCoordinatorOptions {
  readonly transport: WorkerTransport;
  readonly workerExecutablePath: string;
  readonly workerArgs?: readonly string[];
  readonly sessionId?: string;
  readonly debounceMs?: number;
  readonly retryPolicy?: RetryPolicy;
}

interface SubmittedRequest {
  readonly generation: bigint;
  readonly input: EvaluationInput;
}

const DEFAULT_DEBOUNCE_MS = 250;

export class EvaluationCoordinator {
  private readonly transport: WorkerTransport;
  private readonly workerExecutablePath: string;
  private readonly workerArgs: readonly string[];
  private readonly sessionId: string;
  private readonly debounceMs: number;
  private readonly retryPolicy: RetryPolicy;

  private health: WorkerHealth = { phase: "no_worker" };
  private capabilities: readonly string[] = [];
  private latestRequestedGeneration = 0n;
  private generationCounter = 0n;
  private pendingInput: EvaluationInput | null = null;
  private lastSubmittedRequest: SubmittedRequest | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private disposed = false;

  private readonly healthListeners = new Set<(health: WorkerHealth) => void>();
  private readonly outcomeListeners = new Set<(outcome: EvaluationOutcome) => void>();
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(options: EvaluationCoordinatorOptions) {
    this.transport = options.transport;
    this.workerExecutablePath = options.workerExecutablePath;
    this.workerArgs = options.workerArgs ?? [];
    this.sessionId = options.sessionId ?? "machinewright-app";
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryPolicy = options.retryPolicy ?? boundedBackoff();

    this.unsubscribeEvent = this.transport.onEvent((event) => this.handleEvent(event));
    this.unsubscribeExit = this.transport.onExit((exitCode) => this.handleExit(exitCode));
  }

  getHealth(): WorkerHealth {
    return this.health;
  }

  onHealthChange(listener: (health: WorkerHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  onOutcome(listener: (outcome: EvaluationOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  /**
   * Requests evaluation of `input`, debounced. Call this from every
   * `DocumentStore.onChange` notification (any origin) — never gate calling
   * this on "was this a typing event" (that is exactly finding R2).
   */
  requestEvaluation(input: EvaluationInput): void {
    this.pendingInput = input;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.trySubmitPending();
    }, this.debounceMs);
  }

  /**
   * Explicit worker-recovery command (e.g. a "Retry Worker" button), and
   * also invoked automatically by the bounded-backoff schedule after a
   * crash. Always performs the full respawn-and-resend as one transition —
   * this is the R4 fix; there is no other way out of `worker_unhealthy`.
   */
  retry(): void {
    if (this.disposed) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.ensureWorkerReady();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.unsubscribeEvent();
    this.unsubscribeExit();
  }

  private trySubmitPending(): void {
    if (this.pendingInput === null) return;
    if (this.health.phase === "no_worker") {
      void this.ensureWorkerReady();
      return;
    }
    if (this.health.phase === "spawning" || this.health.phase === "handshaking") {
      // Flushed automatically once the handshake completes (see handleEvent's
      // "capabilities" case) or once recovery completes (see ensureWorkerReady).
      return;
    }
    const input = this.pendingInput;
    this.pendingInput = null;
    this.submitNow(input);
  }

  private submitNow(input: EvaluationInput): void {
    const wasEvaluating = this.health.phase === "evaluating";
    const previousGeneration = this.health.phase === "evaluating" ? this.health.generation : null;

    this.generationCounter += 1n;
    const generation = this.generationCounter;
    this.latestRequestedGeneration = generation;

    if (wasEvaluating && previousGeneration !== null) {
      // Advisory only — the worker's cooperative cancellation may or may not
      // land before the current evaluation finishes. Never awaited, never
      // assumed to succeed; the generation filter in handleEvent is what
      // actually makes this safe regardless of outcome.
      void this.transport
        .send(
          create(WorkerRequestSchema, {
            request: { case: "cancel", value: { sessionId: this.sessionId, generation: previousGeneration } },
          }),
        )
        .catch(() => {});
    }

    void this.transport.send(
      create(WorkerRequestSchema, {
        request: {
          case: "evaluate",
          value: {
            sessionId: this.sessionId,
            generation,
            projectRoot: input.projectRoot,
            templateId: input.templateId,
            templateVersion: input.templateVersion,
            inputsJson: input.inputsJson,
            outputDirectory: input.outputDirectory,
            overlays: input.overlays.map((overlay) => ({
              relativePath: overlay.relativePath,
              content: overlay.content,
            })),
            environmentDigest: input.environmentDigest,
          },
        },
      }),
    );

    this.lastSubmittedRequest = { generation, input };
    this.setHealth({ phase: "evaluating", generation, capabilities: this.capabilities });
  }

  /** Resubmits the exact last request under its original generation — used by retry() when no newer edit has arrived since the crash. */
  private resubmitLast(): void {
    const last = this.lastSubmittedRequest;
    if (last === null) return;
    this.latestRequestedGeneration = last.generation > this.latestRequestedGeneration ? last.generation : this.latestRequestedGeneration;
    void this.transport.send(
      create(WorkerRequestSchema, {
        request: {
          case: "evaluate",
          value: {
            sessionId: this.sessionId,
            generation: last.generation,
            projectRoot: last.input.projectRoot,
            templateId: last.input.templateId,
            templateVersion: last.input.templateVersion,
            inputsJson: last.input.inputsJson,
            outputDirectory: last.input.outputDirectory,
            overlays: last.input.overlays.map((overlay) => ({
              relativePath: overlay.relativePath,
              content: overlay.content,
            })),
            environmentDigest: last.input.environmentDigest,
          },
        },
      }),
    );
    this.setHealth({ phase: "evaluating", generation: last.generation, capabilities: this.capabilities });
  }

  private async ensureWorkerReady(): Promise<void> {
    if (this.health.phase === "evaluating" || this.health.phase === "idle") return;
    if (this.health.phase === "spawning" || this.health.phase === "handshaking") return;
    this.setHealth({ phase: "spawning" });
    try {
      await this.transport.spawn(this.workerExecutablePath, [...this.workerArgs]);
      this.setHealth({ phase: "handshaking" });
      await this.transport.send(
        create(WorkerRequestSchema, {
          request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } },
        }),
      );
    } catch {
      this.handleExit(-1);
    }
  }

  private handleEvent(event: WorkerEvent): void {
    switch (event.event.case) {
      case "capabilities": {
        this.capabilities = event.event.value.capabilities;
        this.retryAttempt = 0;
        this.setHealth({ phase: "idle", capabilities: this.capabilities });
        // A fresh edit always wins over resuming an old one (fresh
        // generation via the normal submit path); otherwise, if this
        // handshake completed a crash-recovery respawn, resend whatever was
        // in flight before the crash under its original generation — R4.
        if (this.pendingInput !== null) {
          this.trySubmitPending();
        } else if (this.lastSubmittedRequest !== null) {
          this.resubmitLast();
        }
        return;
      }
      case "progress":
      case "diagnostics":
        // Generation-gated the same as terminal events, but not otherwise
        // acted on by the coordinator itself — surfaced observables/progress
        // are a model/UI-layer concern (see model/Diagnostics.ts), not a
        // reason to change worker health here.
        return;
      case "completed": {
        const { value } = event.event;
        if (value.generation < this.latestRequestedGeneration) return; // stale, drop unconditionally
        this.setHealth({ phase: "idle", capabilities: this.capabilities });
        this.emitOutcome({
          kind: "completed",
          result: {
            generation: value.generation,
            snapshotPath: value.snapshotPath,
            graphDigest: value.graphDigest,
            artifactManifestDigest: value.artifactManifestDigest,
            evaluatedSources: value.evaluatedSources.map((source) => ({
              relativePath: source.relativePath,
              digest: source.digest,
            })),
          },
        });
        return;
      }
      case "failed": {
        const { value } = event.event;
        if (value.generation < this.latestRequestedGeneration) return;
        this.setHealth({ phase: "idle", capabilities: this.capabilities });
        this.emitOutcome({
          kind: "failed",
          failure: {
            generation: value.generation,
            code: value.code,
            message: value.message,
            traceback: value.traceback,
            diagnosticsJson: value.diagnosticsJson,
          },
        });
        return;
      }
      case "cancelled": {
        const { value } = event.event;
        if (value.generation < this.latestRequestedGeneration) return;
        this.setHealth({ phase: "idle", capabilities: this.capabilities });
        this.emitOutcome({ kind: "cancelled", generation: value.generation });
        return;
      }
      default:
        return;
    }
  }

  private handleExit(exitCode: number): void {
    if (this.disposed) return;
    this.setHealth({ phase: "worker_unhealthy", exitCode, attempt: this.retryAttempt });
    const backoff = this.retryPolicy.nextBackoff(this.retryAttempt);
    if (backoff === null) return; // exhausted: wait for an explicit retry() call
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retry();
    }, backoff);
  }

  private setHealth(health: WorkerHealth): void {
    this.health = health;
    for (const listener of this.healthListeners) listener(health);
  }

  private emitOutcome(outcome: EvaluationOutcome): void {
    for (const listener of this.outcomeListeners) listener(outcome);
  }
}
