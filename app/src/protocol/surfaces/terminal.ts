/**
 * Messages between the RN shell and the bundled xterm.js terminal surface
 * (web/terminal). Same transport as the editor surface: JSON over the
 * WebView `postMessage` boundary. The pty itself lives in native code
 * (MachinewrightTerminalModule); this surface only renders bytes and
 * reports keystrokes and size.
 */

/** Commands the shell sends into the terminal surface. */
export type TerminalHostCommand =
  /** Bytes the shell wrote, base64-encoded (a read can end mid UTF-8 sequence). */
  | { readonly kind: "write"; readonly data: string }
  | { readonly kind: "focus" }
  | { readonly kind: "clear" };

/** Events the terminal surface emits back to the shell. */
export type TerminalSurfaceEvent =
  /** The surface has loaded and measured itself; the shell may now start the pty at this size. */
  | { readonly kind: "ready"; readonly cols: number; readonly rows: number }
  /** User input (UTF-8 text, escape sequences included) to forward to the pty. */
  | { readonly kind: "input"; readonly data: string }
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number };
