/**
 * Port interface for the worker transport, matching `WorkerBridge`'s shape
 * exactly (../native/WorkerBridge.ts) so `EvaluationCoordinator` depends on
 * an interface — fakeable in tests without touching `NativeModules` — never
 * on the React Native class directly. `WorkerBridge` requires no changes to
 * satisfy this: TypeScript's structural typing means it already conforms.
 */
import type { create } from "@bufbuild/protobuf";
import type { WorkerEvent, WorkerRequestSchema } from "../protocol/worker/machinewright_worker_pb";

export interface WorkerTransport {
  spawn(executablePath: string, args?: string[]): Promise<void>;
  send(request: ReturnType<typeof create<typeof WorkerRequestSchema>>): Promise<void>;
  onEvent(listener: (event: WorkerEvent) => void): () => void;
  onExit(listener: (exitCode: number) => void): () => void;
  stop(): Promise<void>;
}
