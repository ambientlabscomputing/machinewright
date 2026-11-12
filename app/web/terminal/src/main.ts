/**
 * xterm.js terminal surface. Renders bytes the native pty produced and
 * forwards keystrokes/resizes back through the shell (see
 * src/protocol/surfaces/terminal.ts). No pty or process logic lives here.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import theme from "../../design-system/generated/viewport-theme.json";
import type { TerminalHostCommand, TerminalSurfaceEvent } from "../../../src/protocol/surfaces/terminal";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(event: TerminalSurfaceEvent): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(event));
}

const terminal = new Terminal({
  fontFamily: "'SF Mono', Menlo, monospace",
  fontSize: 12,
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: false,
  theme: {
    background: theme["color-surface-display"],
    foreground: theme["color-text-primary"],
    cursor: theme["color-accent-selection"],
    selectionBackground: `${theme["color-accent-selection"]}40`,
    red: theme["color-status-error"],
    green: theme["color-status-success"],
    yellow: theme["color-status-warning"],
    blue: theme["color-accent-selection"],
    brightBlack: theme["color-text-secondary"],
  },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
const container = document.getElementById("terminal") as HTMLElement;
terminal.open(container);

function refit(): void {
  // fit() throws/no-ops while the container has no size (panel collapsed).
  if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
}

terminal.onData((data) => post({ kind: "input", data }));
terminal.onResize(({ cols, rows }) => post({ kind: "resize", cols, rows }));
new ResizeObserver(refit).observe(container);

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

window.addEventListener("message", (event: MessageEvent<string>) => {
  const command = JSON.parse(event.data) as TerminalHostCommand;
  switch (command.kind) {
    case "write":
      terminal.write(base64ToBytes(command.data));
      break;
    case "focus":
      terminal.focus();
      break;
    case "clear":
      terminal.clear();
      break;
  }
});

refit();
post({ kind: "ready", cols: terminal.cols, rows: terminal.rows });
