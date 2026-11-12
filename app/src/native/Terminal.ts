/**
 * TS wrapper around `MachinewrightTerminalModule`: pty-backed shell
 * sessions. Output arrives as base64 chunks (a read can end mid UTF-8
 * sequence, so bytes — not strings — are the unit); input is plain text.
 */
import { NativeEventEmitter, NativeModules } from "react-native";

interface MachinewrightTerminalNativeModule {
  start(cwd: string, cols: number, rows: number): Promise<number>;
  write(sessionId: number, data: string): void;
  resize(sessionId: number, cols: number, rows: number): void;
  kill(sessionId: number): void;
}

function nativeModule(): MachinewrightTerminalNativeModule {
  const native = NativeModules.MachinewrightTerminalModule as MachinewrightTerminalNativeModule | undefined;
  if (!native) {
    throw new Error("MachinewrightTerminalModule native module is not linked — check macos/ target membership");
  }
  return native;
}

export interface TerminalSessionListeners {
  /** Base64-encoded bytes written by the shell. */
  readonly onData: (base64: string) => void;
  readonly onExit: (exitCode: number) => void;
}

export interface TerminalSession {
  readonly id: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Stops delivering events; does not kill the shell. */
  detach(): void;
}

export async function startTerminalSession(
  cwd: string,
  size: { readonly cols: number; readonly rows: number },
  listeners: TerminalSessionListeners,
): Promise<TerminalSession> {
  const native = nativeModule();
  const emitter = new NativeEventEmitter(NativeModules.MachinewrightTerminalModule);
  // Subscribe before starting so no early output (the first prompt) is missed;
  // the id isn't known yet, so buffer until `start` resolves.
  let sessionId: number | null = null;
  const pending: { type: "data" | "exit"; value: string | number }[] = [];
  const deliver = (type: "data" | "exit", value: string | number) => {
    if (type === "data") listeners.onData(value as string);
    else listeners.onExit(value as number);
  };
  const dataSubscription = emitter.addListener("MachinewrightTerminalData", (event: { id: number; data: string }) => {
    if (sessionId === null) pending.push({ type: "data", value: event.data });
    else if (event.id === sessionId) deliver("data", event.data);
  });
  const exitSubscription = emitter.addListener("MachinewrightTerminalExit", (event: { id: number; code: number }) => {
    if (sessionId === null) pending.push({ type: "exit", value: event.code });
    else if (event.id === sessionId) deliver("exit", event.code);
  });
  const detach = () => {
    dataSubscription.remove();
    exitSubscription.remove();
  };
  try {
    sessionId = await native.start(cwd, size.cols, size.rows);
  } catch (error) {
    detach();
    throw error;
  }
  const id = sessionId;
  for (const item of pending.splice(0)) deliver(item.type, item.value);
  return {
    id,
    write: (data) => native.write(id, data),
    resize: (cols, rows) => native.resize(id, cols, rows),
    kill: () => native.kill(id),
    detach,
  };
}
