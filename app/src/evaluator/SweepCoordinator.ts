/**
 * Orchestrates a small bounded pool of worker processes to evaluate the
 * points of a sweep — RFD-19 M3's "cancellable parameter sweeps... may run
 * in parallel workers when project safety and resource limits allow it."
 *
 * `EvaluationCoordinator` is deliberately not reused or extended for this:
 * it is built around exactly one long-lived worker evaluating one project
 * generation at a time (see its own doc comment on the worker's FIFO command
 * queue). A sweep needs several independent worker *processes*, each
 * evaluating a slice of the point list — that's a different orchestration
 * problem, not a bigger version of the same one.
 *
 * Cancellation here is the same advisory model `EvaluationCoordinator` uses:
 * `cancel()` sends `CancelSweep` to every pool worker and stops dispatching
 * queued points, but does not assume any in-flight point stops immediately.
 * Results are filtered by `sweepId` (an event for an old, superseded sweep
 * is dropped unconditionally), mirroring the generation filter there.
 *
 * A worker crash mid-sweep does not fail the whole sweep: the crashed
 * slot's in-flight point is requeued, and that slot is respawned under
 * `RetryPolicy`'s bounded backoff (reused as-is from evaluator/RetryPolicy).
 * If every pool slot is eventually exhausted, remaining queued points are
 * reported as failed rather than left to hang forever.
 */
import { create } from "@bufbuild/protobuf";
import { WorkerRequestSchema, type WorkerEvent } from "../protocol/worker/machinewright_worker_pb";
import type { WorkerTransport } from "./WorkerTransport";
import { boundedBackoff, type RetryPolicy } from "./RetryPolicy";

export interface SweepCoordinateInput {
  readonly parameterPath: string;
  readonly value: number;
}

export interface SweepPointInput {
  readonly index: number;
  readonly coordinates: readonly SweepCoordinateInput[];
}

export interface SweepRequestInput {
  readonly projectRoot: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly baselineInputsJson: Uint8Array;
  readonly outputDirectory: string;
  readonly environmentDigest?: string;
  readonly points: readonly SweepPointInput[];
}

export interface SweepPointResult {
  readonly pointIndex: number;
  readonly snapshotPath: string;
  readonly graphDigest: string;
  readonly artifactManifestDigest: string;
}

export interface SweepPointFailureInfo {
  readonly pointIndex: number;
  readonly code: string;
  readonly message: string;
}

export type SweepPointOutcome =
  | { readonly kind: "completed"; readonly result: SweepPointResult }
  | { readonly kind: "failed"; readonly failure: SweepPointFailureInfo }
  | { readonly kind: "cancelled"; readonly pointIndex: number };

export interface SweepCoordinatorOptions {
  readonly createTransport: () => WorkerTransport;
  readonly workerExecutablePath: string;
  readonly workerArgs?: readonly string[];
  readonly sessionId?: string;
  /** Bounded, not user-exposed — RFD-19 frames sweep parallelism as
   * safety/resource-limited, not a user dial. */
  readonly poolSize?: number;
  readonly retryPolicy?: RetryPolicy;
}

interface PoolWorker {
  readonly id: number;
  transport: WorkerTransport;
  ready: boolean;
  dead: boolean;
  currentPointIndex: number | null;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  unsubscribeEvent: () => void;
  unsubscribeExit: () => void;
}

const DEFAULT_POOL_SIZE = 3;

export class SweepCoordinator {
  private readonly createTransport: () => WorkerTransport;
  private readonly workerExecutablePath: string;
  private readonly workerArgs: readonly string[];
  private readonly sessionId: string;
  private readonly poolSize: number;
  private readonly retryPolicy: RetryPolicy;

  private readonly workers: PoolWorker[] = [];
  private pendingQueue: SweepPointInput[] = [];
  private request: SweepRequestInput | null = null;
  private activeSweepId = 0n;
  private sweepIdCounter = 0n;
  private cancelled = false;
  private disposed = false;

  private readonly outcomeListeners = new Set<(outcome: SweepPointOutcome) => void>();

  constructor(options: SweepCoordinatorOptions) {
    this.createTransport = options.createTransport;
    this.workerExecutablePath = options.workerExecutablePath;
    this.workerArgs = options.workerArgs ?? [];
    this.sessionId = options.sessionId ?? "machinewright-app-sweep";
    this.poolSize = Math.max(1, options.poolSize ?? DEFAULT_POOL_SIZE);
    this.retryPolicy = options.retryPolicy ?? boundedBackoff();
  }

  onPointOutcome(listener: (outcome: SweepPointOutcome) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  /** Starts a new sweep, superseding any sweep already in progress on this coordinator's pool. */
  start(request: SweepRequestInput): void {
    if (this.disposed) return;
    this.activeSweepId = (this.sweepIdCounter += 1n);
    this.request = request;
    this.pendingQueue = [...request.points];
    this.cancelled = false;

    const slots = Math.min(this.poolSize, Math.max(1, request.points.length));
    while (this.workers.length < slots) {
      this.spawnWorker(this.workers.length);
    }
    for (const worker of this.workers.slice(0, slots)) {
      if (worker.ready) this.dispatchNext(worker);
    }
  }

  /** Advisory: stops dispatching queued points and asks every pool worker to cancel its in-flight point. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const drained = this.pendingQueue;
    this.pendingQueue = [];
    for (const point of drained) {
      this.emitOutcome({ kind: "cancelled", pointIndex: point.index });
    }
    for (const worker of this.workers) {
      if (worker.dead) continue;
      void worker.transport
        .send(
          create(WorkerRequestSchema, {
            request: {
              case: "cancelSweep",
              value: { sessionId: this.sessionId, sweepId: this.activeSweepId },
            },
          }),
        )
        .catch(() => {});
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    for (const worker of this.workers) {
      if (worker.retryTimer !== null) clearTimeout(worker.retryTimer);
      worker.unsubscribeEvent();
      worker.unsubscribeExit();
      void worker.transport.stop().catch(() => {});
    }
    this.workers.length = 0;
  }

  private spawnWorker(id: number): void {
    const transport = this.createTransport();
    const worker: PoolWorker = {
      id,
      transport,
      ready: false,
      dead: false,
      currentPointIndex: null,
      retryAttempt: 0,
      retryTimer: null,
      unsubscribeEvent: () => {},
      unsubscribeExit: () => {},
    };
    worker.unsubscribeEvent = transport.onEvent((event) => this.handleEvent(worker, event));
    worker.unsubscribeExit = transport.onExit((exitCode) => this.handleExit(worker, exitCode));
    this.workers.push(worker);
    this.bootWorker(worker);
  }

  private bootWorker(worker: PoolWorker): void {
    void worker.transport
      .spawn(this.workerExecutablePath, [...this.workerArgs])
      .then(() =>
        worker.transport.send(
          create(WorkerRequestSchema, {
            request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } },
          }),
        ),
      )
      .catch(() => this.handleExit(worker, -1));
  }

  private dispatchNext(worker: PoolWorker): void {
    if (this.cancelled || this.disposed) return;
    if (this.pendingQueue.length === 0) return;
    const request = this.request;
    if (request === null) return;
    const point = this.pendingQueue.shift()!;
    worker.currentPointIndex = point.index;
    void worker.transport.send(
      create(WorkerRequestSchema, {
        request: {
          case: "evaluateSweepPoint",
          value: {
            sessionId: this.sessionId,
            sweepId: this.activeSweepId,
            pointIndex: point.index,
            coordinates: point.coordinates.map((coordinate) => ({
              parameterPath: coordinate.parameterPath,
              value: coordinate.value,
            })),
            projectRoot: request.projectRoot,
            templateId: request.templateId,
            templateVersion: request.templateVersion,
            baselineInputsJson: request.baselineInputsJson,
            outputDirectory: request.outputDirectory,
            environmentDigest: request.environmentDigest ?? "",
          },
        },
      }),
    );
  }

  private handleEvent(worker: PoolWorker, event: WorkerEvent): void {
    switch (event.event.case) {
      case "capabilities": {
        worker.ready = true;
        worker.retryAttempt = 0;
        this.dispatchNext(worker);
        return;
      }
      case "sweepPointCompleted": {
        const { value } = event.event;
        if (value.sweepId !== this.activeSweepId) return; // stale sweep, drop unconditionally
        worker.currentPointIndex = null;
        this.emitOutcome({
          kind: "completed",
          result: {
            pointIndex: value.pointIndex,
            snapshotPath: value.snapshotPath,
            graphDigest: value.graphDigest,
            artifactManifestDigest: value.artifactManifestDigest,
          },
        });
        this.dispatchNext(worker);
        return;
      }
      case "sweepPointFailed": {
        const { value } = event.event;
        if (value.sweepId !== this.activeSweepId) return;
        worker.currentPointIndex = null;
        this.emitOutcome({
          kind: "failed",
          failure: { pointIndex: value.pointIndex, code: value.code, message: value.message },
        });
        this.dispatchNext(worker);
        return;
      }
      case "sweepPointCancelled": {
        const { value } = event.event;
        if (value.sweepId !== this.activeSweepId) return;
        worker.currentPointIndex = null;
        this.emitOutcome({ kind: "cancelled", pointIndex: value.pointIndex });
        this.dispatchNext(worker);
        return;
      }
      default:
        // Regular single-evaluation events never arrive on a sweep-pool
        // transport (each pool worker only ever receives EvaluateSweepPoint
        // requests); progress/diagnostics are not emitted for sweep points.
        return;
    }
  }

  private handleExit(worker: PoolWorker, _exitCode: number): void {
    if (this.disposed) return;
    worker.ready = false;
    const interruptedPointIndex = worker.currentPointIndex;
    worker.currentPointIndex = null;
    if (interruptedPointIndex !== null && this.request !== null && !this.cancelled) {
      const interrupted = this.request.points.find((point) => point.index === interruptedPointIndex);
      if (interrupted !== undefined) this.pendingQueue.unshift(interrupted);
    }

    const backoff = this.retryPolicy.nextBackoff(worker.retryAttempt);
    if (backoff === null) {
      worker.dead = true;
      this.failIfAllWorkersDead();
      return;
    }
    worker.retryAttempt += 1;
    worker.retryTimer = setTimeout(() => {
      worker.retryTimer = null;
      this.bootWorker(worker);
    }, backoff);
  }

  /** Safety net: if every pool slot has exhausted its retry budget, the
   * queue would otherwise never drain. Report remaining points as failed
   * instead of hanging silently. */
  private failIfAllWorkersDead(): void {
    if (!this.workers.every((worker) => worker.dead)) return;
    const remaining = this.pendingQueue;
    this.pendingQueue = [];
    this.cancelled = true;
    for (const point of remaining) {
      this.emitOutcome({
        kind: "failed",
        failure: {
          pointIndex: point.index,
          code: "sweep.no_workers_available",
          message: "every worker in the sweep pool crashed and exhausted its retry budget",
        },
      });
    }
  }

  private emitOutcome(outcome: SweepPointOutcome): void {
    for (const listener of this.outcomeListeners) listener(outcome);
  }
}
