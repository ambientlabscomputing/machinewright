/**
 * Runs on-demand export jobs (parts STL/STEP, print-plate layouts) on the
 * project's shared worker.
 *
 * Jobs are addressed by `(sessionId, jobId)` rather than an evaluation
 * generation, so they never touch the live-preview evaluation stream: the
 * `EvaluationCoordinator`'s generation filter ignores these events, and this
 * coordinator ignores evaluation events. The worker handles requests FIFO, so a
 * job queued behind an in-flight evaluation simply starts when it finishes.
 *
 * Cancellation is advisory (the worker checks between files/plates), exactly
 * like evaluation cancellation: `cancel()` asks, and the outcome promise still
 * resolves with whatever the worker actually reports.
 */
import { create } from "@bufbuild/protobuf";
import { WorkerRequestSchema, type WorkerEvent } from "../protocol/worker/machinewright_worker_pb";
import type { WorkerTransport } from "../evaluator/WorkerTransport";
import type { SourceOverlayInput } from "../evaluator/EvaluationCoordinator";

export type ExportJobKind = "parts" | "print_plan" | "bom_sourcing";

export interface ExportJobInput {
  readonly projectRoot: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly inputsJson: Uint8Array;
  readonly overlays: readonly SourceOverlayInput[];
  readonly environmentDigest: string;
  readonly kind: ExportJobKind;
  /** Empty for a plan-only print job, which writes nothing. */
  readonly outputDirectory: string;
  /** The kind's options document; serialized as JSON for the worker. */
  readonly options: unknown;
  readonly basename: string;
}

export interface ExportProgress {
  readonly stage: string;
  readonly completed: number;
  readonly total: number;
  readonly message: string;
}

export type ExportJobOutcome =
  | { readonly kind: "completed"; readonly outputDirectory: string; readonly result: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly message: string; readonly traceback: string }
  | { readonly kind: "cancelled" };

export interface ExportJobHandle {
  readonly jobId: bigint;
  readonly outcome: Promise<ExportJobOutcome>;
  cancel(): void;
}

export interface ExportCoordinatorOptions {
  readonly transport: WorkerTransport;
  readonly sessionId?: string;
  /**
   * The worker's advertised capabilities, if known. A worker without `export_jobs.v1`
   * (a project pinned to an older Machinewright) silently ignores export requests, so
   * jobs are refused up front instead of waiting forever. An empty list means "not yet known".
   */
  readonly capabilities?: () => readonly string[];
}

export const EXPORT_CAPABILITY = "export_jobs.v1";

interface PendingJob {
  readonly resolve: (outcome: ExportJobOutcome) => void;
  readonly onProgress?: (progress: ExportProgress) => void;
}

export class ExportCoordinator {
  private readonly transport: WorkerTransport;
  private readonly sessionId: string;
  private readonly capabilities: () => readonly string[];
  private readonly pending = new Map<bigint, PendingJob>();
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeExit: () => void;
  private jobCounter = 0n;

  constructor(options: ExportCoordinatorOptions) {
    this.transport = options.transport;
    this.sessionId = options.sessionId ?? "machinewright-app";
    this.capabilities = options.capabilities ?? (() => []);
    this.unsubscribeEvent = this.transport.onEvent((event) => this.handleEvent(event));
    this.unsubscribeExit = this.transport.onExit((code) => this.failAll(`The worker exited (code ${code}) during the export.`));
  }

  run(input: ExportJobInput, onProgress?: (progress: ExportProgress) => void): ExportJobHandle {
    this.jobCounter += 1n;
    const jobId = this.jobCounter;
    const outcome = new Promise<ExportJobOutcome>((resolve) => {
      this.pending.set(jobId, { resolve, onProgress });
    });
    const known = this.capabilities();
    if (known.length > 0 && !known.includes(EXPORT_CAPABILITY)) {
      this.settle(jobId, {
        kind: "failed",
        code: "export.unsupported_worker",
        message:
          "This project's Machinewright version is too old to export. Update its machinewright dependency " +
          "(then run uv sync) and retry the worker.",
        traceback: "",
      });
      return { jobId, outcome, cancel: () => {} };
    }
    this.transport
      .send(
        create(WorkerRequestSchema, {
          request: {
            case: "runExportJob",
            value: {
              sessionId: this.sessionId,
              jobId,
              projectRoot: input.projectRoot,
              templateId: input.templateId,
              templateVersion: input.templateVersion,
              inputsJson: input.inputsJson,
              overlays: input.overlays.map((overlay) => ({
                relativePath: overlay.relativePath,
                content: overlay.content,
              })),
              environmentDigest: input.environmentDigest,
              kind: input.kind,
              outputDirectory: input.outputDirectory,
              optionsJson: new TextEncoder().encode(JSON.stringify(input.options)),
              basename: input.basename,
            },
          },
        }),
      )
      .catch((error: unknown) => this.settle(jobId, { kind: "failed", code: "export.send_failed", message: String(error), traceback: "" }));
    return {
      jobId,
      outcome,
      cancel: () => {
        void this.transport
          .send(create(WorkerRequestSchema, { request: { case: "cancelExportJob", value: { sessionId: this.sessionId, jobId } } }))
          .catch(() => {});
      },
    };
  }

  dispose(): void {
    this.unsubscribeEvent();
    this.unsubscribeExit();
    this.failAll("The project was closed during the export.");
  }

  private settle(jobId: bigint, outcome: ExportJobOutcome): void {
    const job = this.pending.get(jobId);
    if (!job) return;
    this.pending.delete(jobId);
    job.resolve(outcome);
  }

  private failAll(message: string): void {
    for (const jobId of [...this.pending.keys()]) {
      this.settle(jobId, { kind: "failed", code: "export.worker_lost", message, traceback: "" });
    }
  }

  private handleEvent(event: WorkerEvent): void {
    switch (event.event.case) {
      case "exportProgress": {
        const value = event.event.value;
        if (value.sessionId !== this.sessionId) return;
        this.pending.get(value.jobId)?.onProgress?.({
          stage: value.stage,
          completed: value.completed,
          total: value.total,
          message: value.message,
        });
        return;
      }
      case "exportCompleted": {
        const value = event.event.value;
        if (value.sessionId !== this.sessionId) return;
        let result: unknown = null;
        try {
          result = JSON.parse(new TextDecoder().decode(value.resultJson));
        } catch {
          // A completed job with an unreadable result is still a completed job.
        }
        this.settle(value.jobId, { kind: "completed", outputDirectory: value.outputDirectory, result });
        return;
      }
      case "exportFailed": {
        const value = event.event.value;
        if (value.sessionId !== this.sessionId) return;
        this.settle(value.jobId, { kind: "failed", code: value.code, message: value.message, traceback: value.traceback });
        return;
      }
      case "exportCancelled": {
        const value = event.event.value;
        if (value.sessionId !== this.sessionId) return;
        this.settle(value.jobId, { kind: "cancelled" });
        return;
      }
      default:
        return;
    }
  }
}
