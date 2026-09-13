/**
 * three.js viewport WebView hosting, split into two layers:
 *
 * - `ViewportSurfaceView` — the reusable "host the bundled three.js WebView
 *   and translate the prepare/commit/pick postMessage boundary" primitive,
 *   with no opinion on where geometry comes from. This is what M2's
 *   `evaluator/SnapshotInstaller` (`ViewportSurfacePort`) and `app/AppShell`
 *   drive in the real product shell.
 * - `ViewportHost` — the original B.4 architecture-spike screen (RFD-19
 *   spike steps 6, 7, 15, plus the B.2 hosting/recovery proof from steps
 *   14, 16), now built on top of `ViewportSurfaceView` instead of
 *   duplicating its WebView-hosting logic. Its behavior is unchanged: it
 *   still runs its own standalone one-shot evaluation against the
 *   reference project via a throwaway `WorkerBridge`, reachable from the
 *   app's "Dev Tools" tab for independent re-verification.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import WebView from "react-native-webview";
// See EditorHost.tsx for why: react-native-webview's macOS ref/message
// event types have real gaps (ref typed `unknown`; WebViewMessageEvent
// not re-exported from the platform entry point).
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { getBundledAssetURL, getMeshFileURL, readTextFile } from "../native/BundledAssets";
import { WorkerBridge } from "../native/WorkerBridge";
import { WorkerRequestSchema } from "../protocol/worker/machinewright_worker_pb";
import {
  serializeViewportHostCommand,
  deserializeViewportSurfaceEvent,
  type MeshRefLite,
  type ViewportHostCommand,
  type ViewportSurfaceEvent,
} from "../protocol/surfaces/viewport";
import type { Generation } from "../protocol/surfaces/version";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import { colors } from "../design-system/tokens/colors";

interface WebViewRefLike {
  reload: () => void;
  postMessage: (message: string) => void;
}

export interface ViewportSurfaceHandle {
  prepareSnapshot(command: {
    generation: Generation;
    artifactManifestDigest: string;
    meshes: readonly MeshRefLite[];
  }): void;
  commitSnapshot(generation: Generation): void;
  discardSnapshot(generation: Generation): void;
  setSelection(generation: Generation, nodeIds: readonly string[], primaryNodeId: string | null): void;
  fitCamera(): void;
}

export interface ViewportSurfaceViewProps {
  readonly onSurfaceEvent: (event: ViewportSurfaceEvent) => void;
  /** Called after the WebView reloads itself following a content-process termination (RFD-19 failure behavior: "Viewport context loss or WebView crash: keep the application snapshot, reload the surface, and restore cached geometry and presentation state" — the caller is what re-sends the last accepted generation's prepare/commit). */
  readonly onContentProcessTerminate?: () => void;
}

/**
 * The reusable WebView-hosting primitive: resolves the bundled three.js
 * surface, renders the WebView with the file-access prefs mesh loading
 * needs, and translates `ViewportHostCommand`/`ViewportSurfaceEvent` across
 * the `postMessage` boundary. Owns no evaluation, worker, or snapshot
 * state — a caller (SnapshotInstaller's `ViewportSurfacePort` in product
 * mode, or `ViewportHost` below in spike mode) drives it entirely through
 * the imperative handle and `onSurfaceEvent`.
 */
export const ViewportSurfaceView = forwardRef<ViewportSurfaceHandle, ViewportSurfaceViewProps>(
  function ViewportSurfaceView({ onSurfaceEvent, onContentProcessTerminate }, ref) {
    const [load, setLoad] = useState<{ phase: "resolving" } | { phase: "ready"; url: string } | { phase: "error"; message: string }>({
      phase: "resolving",
    });
    const webViewRef = useRef<WebViewRefLike>(null);

    useEffect(() => {
      let cancelled = false;
      getBundledAssetURL("web/viewport/index.html")
        .then((url) => {
          if (!cancelled) setLoad({ phase: "ready", url });
        })
        .catch((error: unknown) => {
          if (!cancelled) setLoad({ phase: "error", message: String(error) });
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const send = useCallback((command: ViewportHostCommand) => {
      webViewRef.current?.postMessage(serializeViewportHostCommand(command));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        prepareSnapshot: (command) => send({ kind: "prepareSnapshot", ...command }),
        commitSnapshot: (generation) => send({ kind: "commitSnapshot", generation }),
        discardSnapshot: (generation) => send({ kind: "discardSnapshot", generation }),
        setSelection: (generation, nodeIds, primaryNodeId) =>
          send({ kind: "setSelection", generation, nodeIds, primaryNodeId }),
        fitCamera: () => send({ kind: "fitCamera" }),
      }),
      [send],
    );

    const onWebViewMessage = useCallback(
      (event: WebViewMessageEvent) => {
        onSurfaceEvent(deserializeViewportSurfaceEvent(event.nativeEvent.data));
      },
      [onSurfaceEvent],
    );

    const onContentProcessDidTerminate = useCallback(() => {
      webViewRef.current?.reload();
      onContentProcessTerminate?.();
    }, [onContentProcessTerminate]);

    if (load.phase === "resolving") {
      return (
        <View style={styles.status}>
          <Text>Resolving bundled asset…</Text>
        </View>
      );
    }
    if (load.phase === "error") {
      return (
        <View style={styles.status}>
          <Text>Failed to resolve bundled asset: {load.message}</Text>
        </View>
      );
    }
    return (
      <WebView
        ref={webViewRef}
        source={{ uri: load.url }}
        originWhitelist={["file://*"]}
        // Grants the WebView read access beyond the app bundle (needed for
        // mesh files under an evaluation's output directory, unrelated to
        // the bundled web/viewport/index.html it loads) — see
        // MachinewrightAssetsModule.meshFileURL for the digest-validation
        // that scopes what actually gets served.
        allowingReadAccessToURL="file:///"
        // allowingReadAccessToURL alone only governs the *page's own*
        // resource loading (navigation, <img>/<script> tags); WebKit treats
        // each file:// URL as a separate origin for XHR/fetch purposes and
        // blocks cross-origin file:// requests independently of it — these
        // two prefs are what actually let the mesh loader's
        // XMLHttpRequest (web/viewport/src/main.ts) reach a file:// URL
        // outside the page's own directory.
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={onWebViewMessage}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        style={styles.webview}
      />
    );
  },
);

// Spike-only, mirrors App.tsx's B.1 / EditorHost.tsx's B.3 hardcoded
// paths — a real project-open flow (native file picker -> workspace/)
// replaces this in the product shell (app/AppShell.tsx).
const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const WORKER_PATH = `${REPO_ROOT}/.venv/bin/machinewright-worker`;
const OUTPUT_DIRECTORY = "/tmp/machinewright-app-viewport-spike";

type EvaluationState =
  | { phase: "idle" }
  | { phase: "evaluating" }
  | { phase: "preparing_viewport" }
  | { phase: "committed"; graphDigest: string }
  | { phase: "failed"; message: string };

export function ViewportHost() {
  const [evaluation, setEvaluation] = useState<EvaluationState>({ phase: "idle" });
  const [terminatedCount, setTerminatedCount] = useState(0);
  const [pickedNodeId, setPickedNodeId] = useState<string | null>(null);
  const surfaceRef = useRef<ViewportSurfaceHandle>(null);
  const generationRef = useRef<bigint>(1n);
  const bridgeRef = useRef<WorkerBridge | null>(null);

  useEffect(() => {
    return () => {
      void bridgeRef.current?.stop();
    };
  }, []);

  const runEvaluation = useCallback(async () => {
    const generation = generationRef.current;
    setEvaluation({ phase: "evaluating" });
    const bridge = new WorkerBridge();
    bridgeRef.current = bridge;
    bridge.onEvent((event) => {
      switch (event.event.case) {
        case "completed": {
          // TS discriminated-union narrowing on `event.event` doesn't
          // survive being captured by the nested async closure below, so
          // pull the already-narrowed value out into its own constant here.
          const completed = event.event.value;
          void (async () => {
            const snapshotJson = await readTextFile(completed.snapshotPath);
            const snapshot = JSON.parse(snapshotJson) as EvaluationSnapshot;
            const meshes: MeshRefLite[] = await Promise.all(
              (snapshot.meshes ?? []).map(async (mesh) => ({
                graphNodeId: mesh.graph_node_id,
                digest: mesh.digest,
                url: await getMeshFileURL(`${OUTPUT_DIRECTORY}/${mesh.name}`, mesh.digest),
              })),
            );
            setEvaluation({ phase: "preparing_viewport" });
            surfaceRef.current?.prepareSnapshot({
              generation,
              artifactManifestDigest: completed.artifactManifestDigest,
              meshes,
            });
          })().catch((error: unknown) => {
            setEvaluation({ phase: "failed", message: String(error) });
          });
          break;
        }
        case "failed":
          setEvaluation({ phase: "failed", message: event.event.value.message });
          break;
        default:
          break;
      }
    });
    try {
      await bridge.spawn(WORKER_PATH, []);
      await bridge.send(
        create(WorkerRequestSchema, {
          request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } },
        }),
      );
      await bridge.send(
        create(WorkerRequestSchema, {
          request: {
            case: "evaluate",
            value: {
              sessionId: "app-viewport-spike",
              generation,
              projectRoot: REPO_ROOT,
              templateId: "machinewright.reference.simple",
              templateVersion: "1.0.0",
              inputsJson: new TextEncoder().encode(
                JSON.stringify({ requirements: { payload_kg: 10.0 } }),
              ),
              outputDirectory: OUTPUT_DIRECTORY,
              overlays: [],
              environmentDigest: "",
            },
          },
        }),
      );
    } catch (error) {
      setEvaluation({ phase: "failed", message: String(error) });
    }
  }, []);

  const onSurfaceEvent = useCallback(
    (surfaceEvent: ViewportSurfaceEvent) => {
      switch (surfaceEvent.kind) {
        case "ready":
          void runEvaluation();
          break;
        case "prepared":
          surfaceRef.current?.commitSnapshot(surfaceEvent.generation);
          setEvaluation({ phase: "committed", graphDigest: "" });
          break;
        case "prepareFailed":
          setEvaluation({ phase: "failed", message: surfaceEvent.reason });
          break;
        case "pickResult":
          setPickedNodeId(surfaceEvent.graphNodeId);
          break;
        default:
          break;
      }
    },
    [runEvaluation],
  );

  const onContentProcessTerminate = useCallback(() => {
    setTerminatedCount((count) => count + 1);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.webview}>
        <ViewportSurfaceView
          ref={surfaceRef}
          onSurfaceEvent={onSurfaceEvent}
          onContentProcessTerminate={onContentProcessTerminate}
        />
      </View>
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>evaluation: {evaluation.phase}</Text>
        {evaluation.phase === "failed" ? (
          <Text style={styles.statusText}>error: {evaluation.message}</Text>
        ) : null}
        <Text style={styles.statusText}>picked: {pickedNodeId ?? "(none)"}</Text>
        <Text style={styles.statusText}>content-process terminations: {terminatedCount}</Text>
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
