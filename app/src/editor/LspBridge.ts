/**
 * TS-side wrapper around the native `MachinewrightLspModule` (mirrors
 * `src/native/WorkerBridge.ts`'s pattern for the worker process, but for
 * LSP's own JSON-RPC-over-Content-Length framing rather than
 * Machinewright's protobuf framing — see the native module's doc comment).
 */
import { NativeEventEmitter, NativeModules } from "react-native";

interface MachinewrightLspNativeModule {
  spawn(executablePath: string, args: string[]): Promise<void>;
  send(json: string): Promise<void>;
  stop(): Promise<void>;
}

function nativeModule(): MachinewrightLspNativeModule {
  const native = NativeModules.MachinewrightLspModule as
    | MachinewrightLspNativeModule
    | undefined;
  if (!native) {
    throw new Error(
      "MachinewrightLspModule native module is not linked — check macos/ target membership",
    );
  }
  return native;
}

export class LspBridge {
  private readonly emitter = new NativeEventEmitter(NativeModules.MachinewrightLspModule);

  async spawn(executablePath: string, args: string[] = []): Promise<void> {
    await nativeModule().spawn(executablePath, args);
  }

  async send(message: unknown): Promise<void> {
    await nativeModule().send(JSON.stringify(message));
  }

  async stop(): Promise<void> {
    await nativeModule().stop();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    const subscription = this.emitter.addListener(
      "MachinewrightLspMessage",
      (body: { json: string }) => {
        listener(JSON.parse(body.json));
      },
    );
    return () => subscription.remove();
  }

  onExit(listener: (exitCode: number) => void): () => void {
    const subscription = this.emitter.addListener(
      "MachinewrightLspExit",
      (body: { exitCode: number }) => listener(body.exitCode),
    );
    return () => subscription.remove();
  }
}
