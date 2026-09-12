/**
 * B.5 spike: selection sync across editor and viewport (RFD-19
 * architecture-spike steps 7, 8, 9). Runs exactly one evaluation and
 * hosts the editor (B.3) and viewport (B.4) WebViews side by side,
 * driven by one shared `Selection` value (src/model/Selection.ts) and
 * resolved through the snapshot's `source_mappings`
 * (src/model/sourceMapping.ts) — never per-surface local selection state
 * (the R3/R7 fix; see those modules' doc comments for the exact review
 * findings this targets).
 *
 * This is the "does the whole vertical slice actually compose" proof:
 * picking geometry in the viewport navigates/highlights the defining code,
 * and placing the cursor in the code highlights the corresponding
 * geometry — RFD-19's core UX thesis, exercised end to end for the first
 * time. It intentionally duplicates a little WebView-hosting boilerplate
 * from EditorHost.tsx/ViewportHost.tsx (B.3/B.4) rather than refactoring
 * those already-verified standalone spikes to share one evaluation — this
 * stays a separate, additive proof so each phase remains independently
 * re-verifiable from its own tab.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import WebView from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { getBundledAssetURL, getMeshFileURL, readTextFile } from "../native/BundledAssets";
import { WorkerBridge } from "../native/WorkerBridge";
import { WorkerRequestSchema } from "../protocol/worker/machinewright_worker_pb";
import {
  serializeViewportHostCommand,
  deserializeViewportSurfaceEvent,
  type MeshRefLite,
} from "../protocol/surfaces/viewport";
import type { EditorHostCommand, EditorSurfaceEvent } from "../protocol/surfaces/editor";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import { EMPTY_SELECTION, selectionOfNode, selectionOfNodes, type Selection } from "../model/Selection";
import { resolveNodeIdsAtOffset, resolveSpanForNodeId } from "../model/sourceMapping";
import { colors } from "../design-system/tokens/colors";

const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const WORKER_PATH = `${REPO_ROOT}/.venv/bin/machinewright-worker`;
const OUTPUT_DIRECTORY = "/tmp/machinewright-app-selection-sync-spike";
// The reference project's template file (examples/reference_project.py)
// only defines the assembly's root node — every pickable part (base_plate,
// the pins) is defined here instead, so this is the file that actually
// demonstrates viewport-pick -> code-highlight.
const DOCUMENT_RELATIVE_PATH = "src/machinewright/examples/reference_hardware.py";
// `SourceSpan.path` (evaluation.py) is project-root-relative — the native
// file read and the editor's own opaque path echo need the absolute form,
// but every lookup into `snapshot.source_mappings` must use the relative
// one, or it silently never matches (comparing an absolute string to a
// relative one is not a type error, just always false).
const DOCUMENT_PATH = `${REPO_ROOT}/${DOCUMENT_RELATIVE_PATH}`;

interface WebViewRefLike {
  postMessage: (message: string) => void;
}

export function SelectionSyncSpike() {
  const [editorURL, setEditorURL] = useState<string | null>(null);
  const [viewportURL, setViewportURL] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [viewportReady, setViewportReady] = useState(false);
  const [documentText, setDocumentText] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<EvaluationSnapshot | null>(null);
  const [meshRefs, setMeshRefs] = useState<readonly MeshRefLite[] | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [status, setStatus] = useState("starting");

  const editorRef = useRef<WebViewRefLike>(null);
  const viewportRef = useRef<WebViewRefLike>(null);
  const bridgeRef = useRef<WorkerBridge | null>(null);
  const sentLoadDocument = useRef(false);
  const sentPrepare = useRef(false);
  const generationRef = useRef<bigint>(1n);

  // Resolve bundled surface URLs once.
  useEffect(() => {
    getBundledAssetURL("web/editor/index.html").then(setEditorURL);
    getBundledAssetURL("web/viewport/index.html").then(setViewportURL);
  }, []);

  // Run the one evaluation this whole spike shares, independent of
  // WebView readiness — evaluation and WebView loading proceed in
  // parallel; each surface's initial command waits on both being ready.
  useEffect(() => {
    readTextFile(DOCUMENT_PATH).then(setDocumentText);

    const bridge = new WorkerBridge();
    bridgeRef.current = bridge;
    bridge.onEvent((event) => {
      if (event.event.case === "completed") {
        const completed = event.event.value;
        setStatus("loading snapshot");
        void (async () => {
          const snapshotJson = await readTextFile(completed.snapshotPath);
          const parsed = JSON.parse(snapshotJson) as EvaluationSnapshot;
          const meshes = await Promise.all(
            (parsed.meshes ?? []).map(async (mesh) => ({
              graphNodeId: mesh.graph_node_id,
              digest: mesh.digest,
              url: await getMeshFileURL(`${OUTPUT_DIRECTORY}/${mesh.name}`, mesh.digest),
            })),
          );
          setSnapshot(parsed);
          setMeshRefs(meshes);
          setStatus("ready");
        })().catch((error: unknown) => setStatus(`failed: ${String(error)}`));
      } else if (event.event.case === "failed") {
        setStatus(`failed: ${event.event.value.message}`);
      }
    });
    void (async () => {
      setStatus("evaluating");
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
              sessionId: "app-selection-sync-spike",
              generation: generationRef.current,
              projectRoot: REPO_ROOT,
              templateId: "machinewright.reference.simple",
              templateVersion: "1.0.0",
              inputsJson: new TextEncoder().encode(JSON.stringify({ requirements: { payload_kg: 10.0 } })),
              outputDirectory: OUTPUT_DIRECTORY,
              overlays: [],
              environmentDigest: "",
            },
          },
        }),
      );
    })().catch((error: unknown) => setStatus(`failed: ${String(error)}`));

    return () => {
      void bridge.stop();
    };
  }, []);

  // Send each surface's initial command exactly once both its WebView and
  // the data it needs are ready.
  useEffect(() => {
    if (editorReady && documentText !== null && !sentLoadDocument.current) {
      sentLoadDocument.current = true;
      const command: EditorHostCommand = {
        kind: "loadDocument",
        path: DOCUMENT_PATH,
        content: documentText,
        documentVersion: 1,
        readOnly: false,
      };
      editorRef.current?.postMessage(JSON.stringify(command));
    }
  }, [editorReady, documentText]);

  useEffect(() => {
    if (viewportReady && meshRefs !== null && snapshot !== null && !sentPrepare.current) {
      sentPrepare.current = true;
      viewportRef.current?.postMessage(
        serializeViewportHostCommand({
          kind: "prepareSnapshot",
          generation: generationRef.current,
          artifactManifestDigest: snapshot.artifact_manifest_digest,
          meshes: meshRefs,
        }),
      );
    }
  }, [viewportReady, meshRefs, snapshot]);

  // Viewport pick -> highlight the defining code (RFD-19's "select a
  // component in 3D and see its defining code" thesis, forward direction).
  const onViewportMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const surfaceEvent = deserializeViewportSurfaceEvent(event.nativeEvent.data);
      if (surfaceEvent.kind === "ready") {
        setViewportReady(true);
      } else if (surfaceEvent.kind === "prepared") {
        viewportRef.current?.postMessage(
          serializeViewportHostCommand({ kind: "commitSnapshot", generation: surfaceEvent.generation }),
        );
        setStatus("committed");
      } else if (surfaceEvent.kind === "prepareFailed") {
        setStatus(`viewport prepare failed: ${surfaceEvent.reason}`);
      } else if (surfaceEvent.kind === "pickResult" && surfaceEvent.graphNodeId && snapshot) {
        const nodeId = surfaceEvent.graphNodeId;
        setSelection(selectionOfNode(nodeId));
        const span = resolveSpanForNodeId(snapshot, nodeId);
        if (span && span.path === DOCUMENT_RELATIVE_PATH) {
          const command: EditorHostCommand = {
            kind: "setSelection",
            path: DOCUMENT_PATH,
            range: { startByte: span.startByte, endByte: span.endByte },
          };
          editorRef.current?.postMessage(JSON.stringify(command));
        }
      }
    },
    [snapshot],
  );

  // Editor cursor/selection -> highlight the corresponding geometry
  // (RFD-19's thesis, reverse direction).
  const onEditorMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const surfaceEvent = JSON.parse(event.nativeEvent.data) as EditorSurfaceEvent;
      if (surfaceEvent.kind === "ready") {
        setEditorReady(true);
      } else if (surfaceEvent.kind === "selectionChanged" && snapshot) {
        const nodeIds = resolveNodeIdsAtOffset(snapshot, DOCUMENT_RELATIVE_PATH, surfaceEvent.range.startByte);
        if (nodeIds.length > 0) {
          const next = selectionOfNodes(nodeIds);
          setSelection(next);
          viewportRef.current?.postMessage(
            serializeViewportHostCommand({
              kind: "setSelection",
              generation: generationRef.current,
              nodeIds: next.nodeIds,
              primaryNodeId: next.primaryNodeId,
            }),
          );
        }
      }
    },
    [snapshot],
  );

  return (
    <View style={styles.container}>
      <View style={styles.pane}>
        {editorURL ? (
          <WebView ref={editorRef} source={{ uri: editorURL }} originWhitelist={["file://*"]} onMessage={onEditorMessage} style={styles.webview} />
        ) : null}
      </View>
      <View style={styles.pane}>
        {viewportURL ? (
          <WebView
            ref={viewportRef}
            source={{ uri: viewportURL }}
            originWhitelist={["file://*"]}
            // See ViewportHost.tsx (B.4) for why all three are needed:
            // allowingReadAccessToURL covers the page's own resource
            // loading, the two allow*FromFileURLs prefs separately cover
            // same-page JS reaching a different file:// origin via XHR.
            allowingReadAccessToURL="file:///"
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            onMessage={onViewportMessage}
            style={styles.webview}
          />
        ) : null}
      </View>
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>evaluation: {status}</Text>
        <Text style={styles.statusText}>selection: {selection.primaryNodeId ?? "(none)"}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  pane: { flex: 1 },
  webview: { flex: 1 },
  statusBar: { padding: 6, backgroundColor: colors.surface.panel },
  statusText: { fontSize: 11, fontFamily: "Menlo", color: colors.text.secondary },
});
