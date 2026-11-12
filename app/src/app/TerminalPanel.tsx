/**
 * The in-window terminal: the bundled xterm.js surface (web/terminal) wired
 * to a native pty session (`native/Terminal.ts`). Stays mounted while
 * hidden (see `Resizable`'s `collapsed`) so the shell, its scrollback and
 * any running process survive Cmd+J toggling. If the shell exits, the next
 * Enter starts a fresh one in the same panel.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import WebView from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { getBundledAssetURL } from "../native/BundledAssets";
import { focusSurface } from "../native/Shortcuts";
import { startTerminalSession, type TerminalSession } from "../native/Terminal";
import type { TerminalHostCommand, TerminalSurfaceEvent } from "../protocol/surfaces/terminal";
import { colors } from "../design-system/tokens/colors";

interface WebViewRefLike {
  postMessage: (message: string) => void;
}

export interface TerminalPanelHandle {
  /** Gives the terminal keyboard focus (deferred until the surface has loaded). */
  focus(): void;
  clear(): void;
}

export interface TerminalPanelProps {
  /** Directory the shell starts in; empty means the user's home. */
  readonly cwd: string;
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel({ cwd }, ref) {
  const [webViewURL, setWebViewURL] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webViewRef = useRef<WebViewRefLike>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const readyRef = useRef(false);
  const exitedRef = useRef(false);
  const wantsFocusRef = useRef(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    let cancelled = false;
    getBundledAssetURL("web/terminal/index.html").then(
      (url) => {
        if (!cancelled) setWebViewURL(url);
      },
      (reason: unknown) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const post = useCallback((command: TerminalHostCommand) => {
    webViewRef.current?.postMessage(JSON.stringify(command));
  }, []);

  const doFocus = useCallback(() => {
    void focusSurface("terminal");
    post({ kind: "focus" });
  }, [post]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        wantsFocusRef.current = true;
        if (readyRef.current) {
          wantsFocusRef.current = false;
          doFocus();
        }
      },
      clear: () => post({ kind: "clear" }),
    }),
    [doFocus, post],
  );

  const startSession = useCallback(async () => {
    exitedRef.current = false;
    try {
      const session = await startTerminalSession(cwdRef.current, sizeRef.current, {
        onData: (data) => post({ kind: "write", data }),
        onExit: (code) => {
          exitedRef.current = true;
          sessionRef.current?.detach();
          sessionRef.current = null;
          post({
            kind: "write",
            data: textToBase64(`\r\n\x1b[2m[shell exited with code ${code} — press Enter to restart]\x1b[0m\r\n`),
          });
        },
      });
      sessionRef.current = session;
      session.resize(sizeRef.current.cols, sizeRef.current.rows);
    } catch (reason) {
      setError(`Could not start a shell: ${String(reason)}`);
    }
  }, [post]);

  useEffect(
    () => () => {
      sessionRef.current?.detach();
      sessionRef.current?.kill();
      sessionRef.current = null;
    },
    [],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = JSON.parse(event.nativeEvent.data) as TerminalSurfaceEvent;
      if (message.kind === "ready") {
        sizeRef.current = { cols: message.cols, rows: message.rows };
        readyRef.current = true;
        if (!sessionRef.current) void startSession();
        if (wantsFocusRef.current) {
          wantsFocusRef.current = false;
          doFocus();
        }
      } else if (message.kind === "input") {
        if (sessionRef.current) sessionRef.current.write(message.data);
        else if (exitedRef.current && message.data.includes("\r")) void startSession();
      } else if (message.kind === "resize") {
        sizeRef.current = { cols: message.cols, rows: message.rows };
        sessionRef.current?.resize(message.cols, message.rows);
      }
    },
    [startSession, doFocus],
  );

  if (error) {
    return (
      <View style={styles.status}>
        <Text style={styles.statusText}>{error}</Text>
      </View>
    );
  }
  if (!webViewURL) {
    return (
      <View style={styles.status}>
        <Text style={styles.statusText}>Resolving bundled terminal asset…</Text>
      </View>
    );
  }
  return (
    <WebView
      ref={webViewRef}
      source={{ uri: webViewURL }}
      originWhitelist={["file://*"]}
      onMessage={onMessage}
      style={styles.webview}
    />
  );
});

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: colors.surface.display },
  status: { flex: 1, padding: 8, backgroundColor: colors.surface.display },
  statusText: { fontSize: 11, color: colors.text.secondary },
});
