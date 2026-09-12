/**
 * TS-side wrapper around the native macOS `MachinewrightWorkerModule`
 * (macos/MachinewrightApp-macOS/MachinewrightWorkerModule.swift), which
 * owns the `machinewright-worker` subprocess's stdio pipes directly.
 *
 * This is the RN-app equivalent of app/tests/protocol/worker-roundtrip.test.ts's
 * Node-based harness — same wire protocol, same framing, different transport
 * (a native bridge event emitter instead of a Node child_process stream).
 * Kept deliberately thin: policy (debounce, generation ordering, retry —
 * see the R4/R7/R12-derived design decisions) belongs to
 * `app/src/evaluator/`, built on top of this, not here.
 */
import { NativeEventEmitter, NativeModules } from "react-native";
import { fromBinary, toBinary, create } from "@bufbuild/protobuf";
import {
  WorkerRequestSchema,
  WorkerEventSchema,
  type WorkerEvent,
} from "../protocol/worker/machinewright_worker_pb";

interface MachinewrightWorkerNativeModule {
  spawn(executablePath: string, args: string[]): Promise<void>;
  send(base64Payload: string): Promise<void>;
  stop(): Promise<void>;
}

function nativeModule(): MachinewrightWorkerNativeModule {
  const native = NativeModules.MachinewrightWorkerModule as
    | MachinewrightWorkerNativeModule
    | undefined;
  if (!native) {
    throw new Error(
      "MachinewrightWorkerModule native module is not linked — check macos/ podspec/target membership",
    );
  }
  return native;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class WorkerBridge {
  private readonly emitter = new NativeEventEmitter(NativeModules.MachinewrightWorkerModule);

  async spawn(executablePath: string, args: string[] = []): Promise<void> {
    await nativeModule().spawn(executablePath, args);
  }

  async send(request: ReturnType<typeof create<typeof WorkerRequestSchema>>): Promise<void> {
    const payload = toBinary(WorkerRequestSchema, request);
    await nativeModule().send(bytesToBase64(payload));
  }

  async stop(): Promise<void> {
    await nativeModule().stop();
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    const subscription = this.emitter.addListener(
      "MachinewrightWorkerFrame",
      (body: { base64Payload: string }) => {
        listener(fromBinary(WorkerEventSchema, base64ToBytes(body.base64Payload)));
      },
    );
    return () => subscription.remove();
  }

  onExit(listener: (exitCode: number) => void): () => void {
    const subscription = this.emitter.addListener(
      "MachinewrightWorkerExit",
      (body: { exitCode: number }) => listener(body.exitCode),
    );
    return () => subscription.remove();
  }
}
