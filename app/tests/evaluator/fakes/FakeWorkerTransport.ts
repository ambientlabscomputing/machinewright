/**
 * In-memory `WorkerTransport` fake for evaluator tests — no NativeModules,
 * no real subprocess. Records every sent request (decoded back to plain
 * fields) so tests can assert exactly what the coordinator sent and in what
 * order, and lets a test script capabilities/completed/failed/exit events
 * on demand to drive the coordinator's state machine deterministically.
 */
import { fromBinary, toBinary, type create } from "@bufbuild/protobuf";
import {
  WorkerRequestSchema,
  type WorkerEvent,
} from "../../../src/protocol/worker/machinewright_worker_pb";
import type { WorkerTransport } from "../../../src/evaluator/WorkerTransport";

export class FakeWorkerTransport implements WorkerTransport {
  readonly spawnCalls: Array<{ executablePath: string; args: string[] }> = [];
  readonly sentRequests: ReturnType<typeof create<typeof WorkerRequestSchema>>[] = [];
  private eventListeners = new Set<(event: WorkerEvent) => void>();
  private exitListeners = new Set<(exitCode: number) => void>();
  spawnShouldFail = false;

  async spawn(executablePath: string, args: string[] = []): Promise<void> {
    this.spawnCalls.push({ executablePath, args });
    if (this.spawnShouldFail) throw new Error("spawn failed");
  }

  async send(request: ReturnType<typeof create<typeof WorkerRequestSchema>>): Promise<void> {
    // Round-trip through the wire encoding, matching what a real transport
    // does, so a test asserting on `sentRequests` sees the same shape
    // production code would produce.
    const bytes = toBinary(WorkerRequestSchema, request);
    this.sentRequests.push(fromBinary(WorkerRequestSchema, bytes) as typeof request);
  }

  async stop(): Promise<void> {
    // No-op: tests drive lifecycle explicitly via emitExit().
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExit(listener: (exitCode: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitEvent(event: WorkerEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener(exitCode);
  }

  /** Convenience: emit a capabilities event as the real worker would right after Hello. */
  emitCapabilities(capabilities: readonly string[] = ["evaluation.v1"]): void {
    this.emitEvent({
      $typeName: "machinewright.worker.v1.WorkerEvent",
      event: {
        case: "capabilities",
        value: {
          $typeName: "machinewright.worker.v1.CapabilityReport",
          protocolVersion: 1,
          capabilities: [...capabilities],
          pythonVersion: "3.13.0",
          interpreter: "cpython",
          machinewrightVersion: "0.2.0",
          cadBackendVersion: "",
          transports: ["stdio"],
        },
      },
    });
  }

  emitCompleted(generation: bigint, overrides: Partial<{ snapshotPath: string; graphDigest: string; artifactManifestDigest: string }> = {}): void {
    this.emitEvent({
      $typeName: "machinewright.worker.v1.WorkerEvent",
      event: {
        case: "completed",
        value: {
          $typeName: "machinewright.worker.v1.EvaluationCompleted",
          sessionId: "machinewright-app",
          generation,
          snapshotPath: overrides.snapshotPath ?? `/tmp/snapshot-${generation}.json`,
          graphDigest: overrides.graphDigest ?? `graph-${generation}`,
          artifactManifestDigest: overrides.artifactManifestDigest ?? `manifest-${generation}`,
          evaluatedSources: [],
        },
      },
    });
  }

  emitFailed(generation: bigint, message = "evaluation failed"): void {
    this.emitEvent({
      $typeName: "machinewright.worker.v1.WorkerEvent",
      event: {
        case: "failed",
        value: {
          $typeName: "machinewright.worker.v1.EvaluationFailed",
          sessionId: "machinewright-app",
          generation,
          code: "evaluation_error",
          message,
          traceback: "",
          diagnosticsJson: new Uint8Array(0),
        },
      },
    });
  }

  emitCancelled(generation: bigint): void {
    this.emitEvent({
      $typeName: "machinewright.worker.v1.WorkerEvent",
      event: {
        case: "cancelled",
        value: { $typeName: "machinewright.worker.v1.EvaluationCancelled", sessionId: "machinewright-app", generation },
      },
    });
  }
}
