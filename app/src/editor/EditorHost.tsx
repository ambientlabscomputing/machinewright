/**
 * B.3 spike: CodeMirror 6 + Python LSP integration proof (RFD-19
 * architecture-spike steps 2, 3). Hosts the bundled editor WebView
 * (web/editor/, built by scripts/build-web-editor.mjs) and a real
 * `pylsp` process, wiring them together through:
 *   - app/src/protocol/surfaces/editor.ts (RN <-> WebView commands/events)
 *   - app/src/editor/LspClient.ts (RN <-> language server JSON-RPC)
 *   - app/src/editor/offsets.ts (LSP position <-> byte offset <-> the
 *     editor's own UTF-16 string indices)
 *
 * Like ViewportHost, this is spike scaffolding proving the mechanism, not
 * the M2 product editor surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import WebView from "react-native-webview";
// See ViewportHost.tsx for why: not re-exported from the platform entry point.
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { getBundledAssetURL, readTextFile } from "../native/BundledAssets";
import { LspClient } from "./LspClient";
import type { EditorSurfaceEvent, EditorDiagnostic } from "../protocol/surfaces/editor";
import { colors } from "../design-system/tokens/colors";

// Spike-only, mirrors App.tsx's B.1 hardcoded path — a real project-open
// flow (native file picker -> workspace/) replaces this in M2.
const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const DOCUMENT_PATH = `${REPO_ROOT}/examples/reference_project.py`;
const LSP_PATH = `${REPO_ROOT}/.venv/bin/pylsp`;
const DOCUMENT_URI = `file://${DOCUMENT_PATH}`;

interface WebViewRefLike {
  postMessage: (message: string) => void;
}

type LspStatus = "idle" | "starting" | "ready" | "failed";

export function EditorHost() {
  const [webViewURL, setWebViewURL] = useState<string | null>(null);
  const [lspStatus, setLspStatus] = useState<LspStatus>("idle");
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const webViewRef = useRef<WebViewRefLike>(null);
  const lspClientRef = useRef<LspClient | null>(null);
  const documentTextRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    getBundledAssetURL("web/editor/index.html").then((url) => {
      if (!cancelled) setWebViewURL(url);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      void lspClientRef.current?.stop();
    };
  }, []);

  const sendDiagnosticsToEditor = useCallback((diagnostics: readonly EditorDiagnostic[]) => {
    webViewRef.current?.postMessage(
      JSON.stringify({
        kind: "setDiagnostics",
        path: DOCUMENT_PATH,
        documentVersion: 0,
        diagnostics,
      }),
    );
  }, []);

  const startLsp = useCallback(async () => {
    setLspStatus("starting");
    const client = new LspClient();
    lspClientRef.current = client;
    client.onDiagnostics = (_uri, diagnostics) => {
      setDiagnosticCount(diagnostics.length);
      sendDiagnosticsToEditor(diagnostics);
    };
    try {
      await client.start(LSP_PATH, `file://${REPO_ROOT}`);
      await client.didOpen(DOCUMENT_URI, "python", documentTextRef.current);
      setLspStatus("ready");
    } catch {
      setLspStatus("failed");
    }
  }, [sendDiagnosticsToEditor]);

  const onEditorMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const surfaceEvent = JSON.parse(event.nativeEvent.data) as EditorSurfaceEvent;
      setLastEvent(surfaceEvent.kind);
      if (surfaceEvent.kind === "ready") {
        readTextFile(DOCUMENT_PATH).then((content) => {
          documentTextRef.current = content;
          webViewRef.current?.postMessage(
            JSON.stringify({
              kind: "loadDocument",
              path: DOCUMENT_PATH,
              content,
              documentVersion: 1,
              readOnly: false,
            }),
          );
          void startLsp();
        });
      } else if (surfaceEvent.kind === "documentChanged") {
        documentTextRef.current = surfaceEvent.content;
        void lspClientRef.current?.didChange(DOCUMENT_URI, surfaceEvent.content);
      }
    },
    [startLsp],
  );

  if (!webViewURL) {
    return (
      <View style={styles.status}>
        <Text>Resolving bundled editor asset…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: webViewURL }}
        originWhitelist={["file://*"]}
        onMessage={onEditorMessage}
        style={styles.webview}
      />
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>lsp: {lspStatus}</Text>
        <Text style={styles.statusText}>diagnostics: {diagnosticCount}</Text>
        <Text style={styles.statusText}>last event: {lastEvent ?? "(none)"}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  statusBar: {
    padding: 6,
    backgroundColor: colors.surface.panel,
  },
  statusText: { fontSize: 11, fontFamily: "Menlo", color: colors.text.secondary },
  status: { flex: 1, alignItems: "center", justifyContent: "center" },
});
