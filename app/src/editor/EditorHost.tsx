/**
 * CodeMirror 6 + Python LSP integration, split into two layers:
 *
 * - `EditorSurfaceView` — the reusable "host the bundled CodeMirror WebView
 *   and translate the load/edit/selection/diagnostics postMessage
 *   boundary" primitive, with no opinion on which project, document, or
 *   language server it belongs to. This is what the product shell
 *   (app/AppShell.tsx) drives directly, backed by `workspace/DocumentStore`
 *   and a project-shared `LspClient`.
 * - `EditorHost` — the original B.3 architecture-spike screen (RFD-19 spike
 *   steps 2, 3), now built on top of `EditorSurfaceView` instead of
 *   duplicating its WebView-hosting logic. Its behavior is unchanged: it
 *   still owns a single throwaway `LspClient` against the hardcoded
 *   reference project, reachable from the app's "Dev Tools" tab.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import WebView from "react-native-webview";
// See ViewportHost.tsx for why: not re-exported from the platform entry point.
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { getBundledAssetURL, readTextFile } from "../native/BundledAssets";
import { LspClient } from "./LspClient";
import type {
  ByteRange,
  DocumentVersion,
  EditorDiagnostic,
  EditorSurfaceEvent,
  LanguageResult,
} from "../protocol/surfaces/editor";
import { colors } from "../design-system/tokens/colors";

interface WebViewRefLike {
  postMessage: (message: string) => void;
}

export interface EditorSurfaceHandle {
  loadDocument(path: string, content: string, documentVersion: DocumentVersion, readOnly?: boolean): void;
  applyExternalEdit(
    path: string,
    content: string,
    documentVersion: DocumentVersion,
    reason: "disk_reload" | "undo" | "redo",
  ): void;
  setSelection(path: string, range: ByteRange): void;
  setDiagnostics(path: string, documentVersion: DocumentVersion, diagnostics: readonly EditorDiagnostic[]): void;
  closeDocument(path: string): void;
  openFind(): void;
  focus(): void;
  languageResult(id: number, result: LanguageResult): void;
}

export interface EditorSurfaceViewProps {
  readonly onSurfaceEvent: (event: EditorSurfaceEvent) => void;
}

/**
 * The reusable WebView-hosting primitive: resolves the bundled CodeMirror
 * surface, renders the WebView, and translates `EditorHostCommand`/
 * `EditorSurfaceEvent` across the `postMessage` boundary. Owns no document,
 * buffer-version, or LSP state — a caller (`app/AppShell.tsx` in product
 * mode, or `EditorHost` below in spike mode) drives it entirely through the
 * imperative handle and `onSurfaceEvent`.
 */
export const EditorSurfaceView = forwardRef<EditorSurfaceHandle, EditorSurfaceViewProps>(
  function EditorSurfaceView({ onSurfaceEvent }, ref) {
    const [webViewURL, setWebViewURL] = useState<string | null>(null);
    const webViewRef = useRef<WebViewRefLike>(null);

    useEffect(() => {
      let cancelled = false;
      getBundledAssetURL("web/editor/index.html").then((url) => {
        if (!cancelled) setWebViewURL(url);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    const post = useCallback((message: unknown) => {
      webViewRef.current?.postMessage(JSON.stringify(message));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        loadDocument: (path, content, documentVersion, readOnly = false) =>
          post({ kind: "loadDocument", path, content, documentVersion, readOnly }),
        applyExternalEdit: (path, content, documentVersion, reason) =>
          post({ kind: "applyExternalEdit", path, content, documentVersion, reason }),
        setSelection: (path, range) => post({ kind: "setSelection", path, range }),
        setDiagnostics: (path, documentVersion, diagnostics) =>
          post({ kind: "setDiagnostics", path, documentVersion, diagnostics }),
        closeDocument: (path) => post({ kind: "closeDocument", path }),
        openFind: () => post({ kind: "openFind" }),
        focus: () => post({ kind: "focus" }),
        languageResult: (id, result) => post({ kind: "languageResult", id, result }),
      }),
      [post],
    );

    const onEditorMessage = useCallback(
      (event: WebViewMessageEvent) => {
        onSurfaceEvent(JSON.parse(event.nativeEvent.data) as EditorSurfaceEvent);
      },
      [onSurfaceEvent],
    );

    if (!webViewURL) {
      return (
        <View style={styles.status}>
          <Text>Resolving bundled editor asset…</Text>
        </View>
      );
    }
    return (
      <WebView
        ref={webViewRef}
        source={{ uri: webViewURL }}
        originWhitelist={["file://*"]}
        onMessage={onEditorMessage}
        style={styles.webview}
      />
    );
  },
);

// Spike-only, mirrors App.tsx's B.1 hardcoded path — a real project-open
// flow (native file picker -> workspace/) replaces this in the product
// shell (app/AppShell.tsx).
const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const DOCUMENT_PATH = `${REPO_ROOT}/examples/reference_project.py`;
const LSP_PATH = `${REPO_ROOT}/.venv/bin/pylsp`;
const DOCUMENT_URI = `file://${DOCUMENT_PATH}`;

type LspStatus = "idle" | "starting" | "ready" | "failed";

export function EditorHost() {
  const [lspStatus, setLspStatus] = useState<LspStatus>("idle");
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const surfaceRef = useRef<EditorSurfaceHandle>(null);
  const lspClientRef = useRef<LspClient | null>(null);
  const documentTextRef = useRef<string>("");
  const documentVersionRef = useRef(1);

  useEffect(() => {
    return () => {
      void lspClientRef.current?.stop();
    };
  }, []);

  const startLsp = useCallback(async () => {
    setLspStatus("starting");
    const client = new LspClient();
    lspClientRef.current = client;
    client.onDiagnostics = (_uri, _text, diagnostics) => {
      setDiagnosticCount(diagnostics.length);
      surfaceRef.current?.setDiagnostics(DOCUMENT_PATH, documentVersionRef.current, diagnostics);
    };
    try {
      await client.start(LSP_PATH, `file://${REPO_ROOT}`);
      await client.didOpen(DOCUMENT_URI, "python", documentTextRef.current);
      setLspStatus("ready");
    } catch {
      setLspStatus("failed");
    }
  }, []);

  const onSurfaceEvent = useCallback(
    (surfaceEvent: EditorSurfaceEvent) => {
      setLastEvent(surfaceEvent.kind);
      if (surfaceEvent.kind === "ready") {
        readTextFile(DOCUMENT_PATH).then((content) => {
          documentTextRef.current = content;
          surfaceRef.current?.loadDocument(DOCUMENT_PATH, content, 1, false);
          void startLsp();
        });
      } else if (surfaceEvent.kind === "documentChanged") {
        documentTextRef.current = surfaceEvent.content;
        documentVersionRef.current = surfaceEvent.documentVersion;
        void lspClientRef.current?.didChange(DOCUMENT_URI, surfaceEvent.content).catch(() => {});
      } else if (surfaceEvent.kind === "languageQuery") {
        surfaceRef.current?.languageResult(surfaceEvent.id, null);
      }
    },
    [startLsp],
  );

  return (
    <View style={styles.container}>
      <View style={styles.webview}>
        <EditorSurfaceView ref={surfaceRef} onSurfaceEvent={onSurfaceEvent} />
      </View>
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
  webview: { flex: 1, backgroundColor: colors.surface.panel },
  statusBar: {
    padding: 6,
    backgroundColor: colors.surface.panel,
  },
  statusText: { fontSize: 11, fontFamily: "Menlo", color: colors.text.secondary },
  status: { flex: 1, alignItems: "center", justifyContent: "center" },
});
