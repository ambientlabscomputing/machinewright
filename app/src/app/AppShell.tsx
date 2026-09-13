/**
 * The real Machinewright product shell (RFD-19 M2: "project/workspace shell
 * and editor... long-lived worker management and unsaved overlays...
 * last-known-good snapshots and structured diagnostics... synchronized
 * source, graph, and 3D selection"). This replaces the B.1-B.7 spikes'
 * hardcoded `REPO_ROOT`/one-shot-evaluation pattern with the real, shared,
 * long-lived instances built across M2: one `DocumentStore`, one
 * `EvaluationCoordinator` (and therefore one shared worker), one
 * `SnapshotStore`, and one `SnapshotInstaller` per open project — never a
 * fresh throwaway instance per screen.
 *
 * Layout: a toolbar; a left panel listing open documents and the graph
 * (`GraphTree`); a center split of the editor and viewport surfaces; a
 * right panel of structured diagnostics. Composed entirely from
 * design-system primitives (RFD-19 "Enforcing the design language").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ScrollView } from "react-native";
import { Button, Panel, Resizable, Stack, StatusBadge, Text } from "../design-system/native";
import { WorkerBridge } from "../native/WorkerBridge";
import { readTextFile } from "../native/BundledAssets";
import { pickFile } from "../native/FilePicker";
import { FileExplorer } from "./FileExplorer";
import { openProjectFromPicker } from "../workspace/OpenProjectFlow";
import { computeEnvironmentDigest } from "../workspace/EnvironmentDigest";
import { nativeDigestPort } from "../workspace/nativeEnvironmentDigest";
import { defaultJoinPath, type ProjectHandle } from "../workspace/Project";
import { DocumentStore, type OpenDocument } from "../workspace/DocumentStore";
import { EvaluationCoordinator, type EvaluationInput, type WorkerHealth } from "../evaluator/EvaluationCoordinator";
import { SnapshotInstaller, type ViewportSurfacePort } from "../evaluator/SnapshotInstaller";
import { createNativeCacheClient } from "../cache/nativeCacheClient";
import { SnapshotStore } from "../model/SnapshotStore";
import { EMPTY_SELECTION, selectionOfNode, selectionOfNodes, type Selection } from "../model/Selection";
import { resolveNodeIdsInMappings, resolveSpanInMappings } from "../model/sourceMapping";
import { fromEditorDiagnostics, mergeDiagnostics, type StructuredDiagnostic } from "../model/Diagnostics";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import { GraphTree } from "../graph/GraphTree";
import { EditorSurfaceView, type EditorSurfaceHandle } from "../editor/EditorHost";
import { ViewportSurfaceView, type ViewportSurfaceHandle } from "../viewport/ViewportHost";
import { LspClient } from "../editor/LspClient";
import type { EditorSurfaceEvent } from "../protocol/surfaces/editor";
import type { ViewportSurfaceEvent } from "../protocol/surfaces/viewport";

const DEFAULT_INPUTS_JSON = new TextEncoder().encode("{}");

/** One project's worth of shared, long-lived state — constructed exactly once per "Open Project", disposed on close/switch. */
interface ProjectSession {
  readonly project: ProjectHandle;
  readonly documentStore: DocumentStore;
  readonly coordinator: EvaluationCoordinator;
  readonly snapshotStore: SnapshotStore;
  readonly snapshotInstaller: SnapshotInstaller;
  readonly lspClient: LspClient;
  readonly outputDirectory: string;
  /** Mutable box, not React state: read by closures registered once at session-build time, so they always see the latest value without needing to be re-registered. */
  readonly environmentDigest: { current: string };
  readonly dispatchViewportEvent: (event: ViewportSurfaceEvent) => void;
  dispose(): void;
}

function buildViewportSurfacePort(
  ref: RefObject<ViewportSurfaceHandle | null>,
): { port: ViewportSurfacePort; dispatch: (event: ViewportSurfaceEvent) => void } {
  const listeners = new Set<(event: ViewportSurfaceEvent) => void>();
  const port: ViewportSurfacePort = {
    prepareSnapshot: (command) => ref.current?.prepareSnapshot(command),
    commitSnapshot: (generation) => ref.current?.commitSnapshot(generation),
    discardSnapshot: (generation) => ref.current?.discardSnapshot(generation),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { port, dispatch: (event) => listeners.forEach((listener) => listener(event)) };
}

async function loadSnapshotJson(snapshotPath: string): Promise<EvaluationSnapshot> {
  return JSON.parse(await readTextFile(snapshotPath)) as EvaluationSnapshot;
}

export function AppShell() {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [health, setHealth] = useState<WorkerHealth>({ phase: "no_worker" });
  const [documents, setDocuments] = useState<readonly OpenDocument[]>([]);
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [snapshotVersion, setSnapshotVersion] = useState(0); // bumped on every SnapshotStore change, to re-derive the memos below
  const [lspDiagnostics, setLspDiagnostics] = useState<readonly StructuredDiagnostic[]>([]);

  // Panel sizes are a UI preference, not machine-affecting state (RFD-19:
  // "The application may store camera positions, layout, recent files, and
  // other presentation preferences outside the package") — plain component
  // state is enough; nothing here is read by evaluation.
  const [explorerWidth, setExplorerWidth] = useState(260);
  const [explorerHeight, setExplorerHeight] = useState(280);
  const [editorWidth, setEditorWidth] = useState(560);
  const [viewportWidth, setViewportWidth] = useState(560);

  const viewportRef = useRef<ViewportSurfaceHandle>(null);
  const editorRef = useRef<EditorSurfaceHandle>(null);
  const generationRef = useRef<bigint>(0n);
  // Read by closures registered once at session-build time (the LSP
  // onDiagnostics callback), so they see the current active document
  // without needing to be re-registered on every switch.
  const activeDocumentPathRef = useRef<string | null>(null);
  activeDocumentPathRef.current = activeDocumentPath;

  const closeSession = useCallback(() => {
    setSession((current) => {
      current?.dispose();
      return null;
    });
    setDocuments([]);
    setActiveDocumentPath(null);
    setEditorReady(false);
    setSelection(EMPTY_SELECTION);
    setHealth({ phase: "no_worker" });
    setLspDiagnostics([]);
  }, []);

  const openProject = useCallback(async () => {
    setOpenError(null);
    let project: ProjectHandle | null;
    try {
      project = await openProjectFromPicker();
    } catch (error) {
      setOpenError(String(error));
      return;
    }
    if (project === null) return; // user cancelled

    closeSession();

    const documentStore = new DocumentStore({ readFile: readTextFile });
    const snapshotStore = new SnapshotStore();
    const transport = new WorkerBridge();
    const coordinator = new EvaluationCoordinator({
      transport,
      workerExecutablePath: project.workerExecutablePath,
    });
    const cacheClient = createNativeCacheClient();
    const outputDirectory = defaultJoinPath(project.rootPath, ".machinewright", "output");
    const { port: viewportPort, dispatch: dispatchViewportEvent } = buildViewportSurfacePort(viewportRef);
    const snapshotInstaller = new SnapshotInstaller({
      viewport: viewportPort,
      snapshotStore,
      cacheClient,
      loadEvaluationSnapshot: loadSnapshotJson,
    });
    const lspClient = new LspClient();
    const environmentDigest = { current: "" };
    // The project's own first declared input configuration (typically
    // examples/inputs/*.json), not a hardcoded stand-in — generating
    // typed-input controls is M3's job (RFD-19 M3: "Generate controls from
    // typed inputs"); M2 just needs *a* real input so the project's actual
    // template can evaluate and its model can be seen at all.
    const inputsJson = { current: DEFAULT_INPUTS_JSON };

    const requestEvaluationNow = () => {
      const template = project.config.templates[0];
      if (!template) return; // no declared template — nothing to evaluate against yet
      const input: EvaluationInput = {
        projectRoot: project.rootPath,
        templateId: template.id,
        templateVersion: template.version,
        inputsJson: inputsJson.current,
        outputDirectory,
        overlays: documentStore.overlaysForEvaluation(),
        environmentDigest: environmentDigest.current,
      };
      coordinator.requestEvaluation(input);
    };

    const unsubscribeHealth = coordinator.onHealthChange((nextHealth) => {
      setHealth(nextHealth);
      if (nextHealth.phase === "worker_unhealthy") snapshotStore.setWorkerUnhealthy();
    });
    const unsubscribeOutcome = coordinator.onOutcome((outcome) => {
      if (outcome.kind === "completed") {
        void snapshotInstaller.stage(outcome.result, outputDirectory);
      } else if (outcome.kind === "failed") {
        snapshotStore.setFailed(outcome.failure.generation, outcome.failure);
      }
    });
    const unsubscribeSnapshot = snapshotStore.subscribe(() => setSnapshotVersion((v) => v + 1));
    const unsubscribeDocuments = documentStore.onChange(() => {
      setDocuments(documentStore.listOpen());
      requestEvaluationNow();
    });

    computeEnvironmentDigest(project.rootPath, project.config.environmentLock, {
      digest: nativeDigestPort,
      joinPath: defaultJoinPath,
    })
      .then((digest) => {
        environmentDigest.current = digest;
      })
      .catch(() => {
        // Digest is best-effort for M2: an unreadable environment_lock still
        // lets evaluation proceed (the worker's own _verify_environment will
        // simply see an empty digest and skip that check), matching
        // workspace/Project.ts's "detection, not repair" scope.
      });

    const firstInputConfiguration = project.config.inputConfigurations[0];
    (firstInputConfiguration
      ? readTextFile(defaultJoinPath(project.rootPath, firstInputConfiguration)).then(
          (json) => new TextEncoder().encode(json),
        )
      : Promise.resolve(DEFAULT_INPUTS_JSON)
    )
      .then((resolvedInputsJson) => {
        inputsJson.current = resolvedInputsJson;
      })
      .catch(() => {
        // Falls back to "{}" — the worker will report a structured
        // validation diagnostic if the template actually requires fields,
        // surfaced in the diagnostics panel rather than silently failing.
      })
      .finally(() => {
        // The real entry point: evaluate as soon as a project is opened, not
        // only after the user's first edit — this is what actually lets an
        // engineer see the model immediately (M2's "synchronized source,
        // graph, and 3D selection" requires geometry to exist at all).
        requestEvaluationNow();
      });

    void lspClient.start(project.lspExecutablePath, `file://${project.rootPath}`).catch(() => {
      // Missing/broken language server degrades to no inline diagnostics —
      // never blocks opening the project or evaluating it.
    });
    lspClient.onDiagnostics = (uri, lspDiagnosticsForDocument) => {
      const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
      setLspDiagnostics(fromEditorDiagnostics(lspDiagnosticsForDocument, path));
      if (path === activeDocumentPathRef.current) {
        editorRef.current?.setDiagnostics(path, 0, lspDiagnosticsForDocument);
      }
    };

    const newSession: ProjectSession = {
      project,
      documentStore,
      coordinator,
      snapshotStore,
      snapshotInstaller,
      lspClient,
      outputDirectory,
      environmentDigest,
      dispatchViewportEvent,
      dispose: () => {
        unsubscribeHealth();
        unsubscribeOutcome();
        unsubscribeSnapshot();
        unsubscribeDocuments();
        snapshotInstaller.dispose();
        coordinator.dispose();
        void lspClient.stop();
      },
    };
    setSession(newSession);
  }, [closeSession]);

  useEffect(() => {
    // Cleanup should only run when `session` itself changes (project
    // opened/closed/replaced) — that identity is exactly what should
    // trigger disposing the previous one, so it is the right and only
    // dependency here.
    return () => session?.dispose();
  }, [session]);

  /** Shared by the "Open File" native picker and `FileExplorer`'s click-to-open. */
  const openFileAtPath = useCallback(
    async (path: string) => {
      if (!session) return;
      await session.documentStore.open(path);
      setDocuments(session.documentStore.listOpen());
      setActiveDocumentPath(path);
    },
    [session],
  );

  const openFile = useCallback(async () => {
    if (!session) return;
    const path = await pickFile(session.project.rootPath);
    if (path === null) return;
    await openFileAtPath(path);
  }, [session, openFileAtPath]);

  const saveActiveDocument = useCallback(() => {
    if (!session || !activeDocumentPath) return;
    session.documentStore.markSaved(activeDocumentPath);
    setDocuments(session.documentStore.listOpen());
  }, [session, activeDocumentPath]);

  const currentSnapshot = useMemo(() => session?.snapshotStore.getAccepted() ?? null, [session, snapshotVersion]);
  const currentStatus = useMemo(
    () => session?.snapshotStore.getStatus() ?? ({ kind: "idle" } as const),
    [session, snapshotVersion],
  );
  const diagnostics = useMemo(
    () => mergeDiagnostics(currentSnapshot?.diagnostics ?? [], lspDiagnostics),
    [currentSnapshot, lspDiagnostics],
  );

  const activeDocument = documents.find((d) => d.path === activeDocumentPath) ?? null;

  /** `activeDocumentPath` relative to the open project's root — what `SourceSpan.path`/`SourceMapping` actually key on. */
  const activeRelativePath = useMemo(() => {
    if (!session || !activeDocumentPath) return null;
    const prefix = `${session.project.rootPath}/`;
    return activeDocumentPath.startsWith(prefix) ? activeDocumentPath.slice(prefix.length) : activeDocumentPath;
  }, [session, activeDocumentPath]);

  const highlightNodeInEditor = useCallback(
    (nodeId: string) => {
      if (!currentSnapshot || !activeDocumentPath || !activeRelativePath) return;
      const span = resolveSpanInMappings(currentSnapshot.sourceMap, nodeId);
      if (span && span.path === activeRelativePath) {
        editorRef.current?.setSelection(activeDocumentPath, { startByte: span.startByte, endByte: span.endByte });
      }
    },
    [currentSnapshot, activeDocumentPath, activeRelativePath],
  );

  const onEditorSurfaceEvent = useCallback(
    (event: EditorSurfaceEvent) => {
      if (event.kind === "ready") {
        setEditorReady(true);
        return;
      }
      if (!session || !activeDocumentPath) return;
      if (event.kind === "documentChanged") {
        session.documentStore.applyChange(activeDocumentPath, event.content, event.origin);
        void session.lspClient.didChange(`file://${activeDocumentPath}`, event.content);
        setDocuments(session.documentStore.listOpen());
      } else if (event.kind === "selectionChanged" && currentSnapshot && activeRelativePath) {
        const nodeIds = resolveNodeIdsInMappings(currentSnapshot.sourceMap, activeRelativePath, event.range.startByte);
        if (nodeIds.length > 0) {
          const next = selectionOfNodes(nodeIds);
          setSelection(next);
          viewportRef.current?.setSelection(generationRef.current, next.nodeIds, next.primaryNodeId);
        }
      }
    },
    [session, activeDocumentPath, currentSnapshot, activeRelativePath],
  );

  const onViewportSurfaceEvent = useCallback(
    (event: ViewportSurfaceEvent) => {
      session?.dispatchViewportEvent(event);
      if (event.kind === "pickResult" && event.graphNodeId) {
        generationRef.current = event.generation;
        setSelection(selectionOfNode(event.graphNodeId));
        highlightNodeInEditor(event.graphNodeId);
      }
    },
    [session, highlightNodeInEditor],
  );

  // The other half of the "ready" handshake above: (re)loads the active
  // document's current buffer into the editor WebView whenever it becomes
  // ready, or whenever the active tab changes — deliberately depending on
  // `activeDocumentPath`/`session`/`editorReady` only, never on `documents`
  // (which is replaced on every keystroke via `documentChanged`): reloading
  // on every edit would blow away the WebView's own cursor/undo state while
  // the user is mid-edit. Reads the document's *current* buffer content
  // directly from the DocumentStore rather than React state, so switching
  // back to a previously-edited tab shows its unsaved changes, not the
  // on-disk original.
  useEffect(() => {
    if (!editorReady || !session || !activeDocumentPath) return;
    const document = session.documentStore.get(activeDocumentPath);
    if (!document) return;
    editorRef.current?.loadDocument(document.path, document.bufferContent, document.documentVersion, false);
  }, [editorReady, session, activeDocumentPath]);

  const onSelectGraphNode = useCallback(
    (next: Selection) => {
      setSelection(next);
      viewportRef.current?.setSelection(generationRef.current, next.nodeIds, next.primaryNodeId);
      if (next.primaryNodeId) highlightNodeInEditor(next.primaryNodeId);
    },
    [highlightNodeInEditor],
  );

  return (
    <Stack flex={1}>
      <Panel surface="panel" padding="sm">
        <Stack direction="row" gap="sm" align="center">
          <Button label="Open Project" onPress={() => void openProject()} />
          <Button label="Open File" onPress={() => void openFile()} disabled={!session} />
          <Button label="Save" onPress={saveActiveDocument} disabled={!activeDocument?.dirty} />
          <Button
            label="Retry Worker"
            tone={health.phase === "worker_unhealthy" ? "action" : "neutral"}
            onPress={() => session?.coordinator.retry()}
            disabled={!session}
          />
          <Button label="Fit Camera" onPress={() => viewportRef.current?.fitCamera()} disabled={!session} />
          <Text variant="label" tone="secondary">
            {session ? session.project.config.projectId : "No project open"}
          </Text>
          <WorkerHealthBadge health={health} />
          {currentStatus.kind === "pending" ? <StatusBadge tone="pending" label="Evaluating…" /> : null}
          {currentStatus.kind === "failed" ? <StatusBadge tone="error" label="Evaluation failed" /> : null}
          {openError ? <Text tone="secondary">{openError}</Text> : null}
        </Stack>
      </Panel>
      <Stack direction="row" flex={1}>
        <Resizable edge="right" size={explorerWidth} onResize={setExplorerWidth} minSize={180} maxSize={520}>
          <Stack flex={1}>
            <Resizable edge="bottom" size={explorerHeight} onResize={setExplorerHeight} minSize={120} maxSize={800}>
              <PanelSection title="Files">
                {session ? (
                  <FileExplorer
                    rootPath={session.project.rootPath}
                    activeFilePath={activeDocumentPath}
                    onOpenFile={(path) => void openFileAtPath(path)}
                  />
                ) : (
                  <Panel surface="panel" flex={1} bordered>
                    <Text tone="secondary">Open a project to browse its files.</Text>
                  </Panel>
                )}
              </PanelSection>
            </Resizable>
            <PanelSection title="Graph">
              <GraphTree graph={currentSnapshot?.graph ?? null} selection={selection} onSelectNode={onSelectGraphNode} />
            </PanelSection>
          </Stack>
        </Resizable>
        <Resizable edge="right" size={editorWidth} onResize={setEditorWidth} minSize={280} maxSize={1400}>
          <Stack flex={1}>
            {documents.length > 0 ? (
              <Panel surface="panel" padding="sm">
                <Stack direction="row" gap="sm" wrap>
                  {documents.map((document) => (
                    <Text
                      key={document.path}
                      variant="label"
                      tone={document.path === activeDocumentPath ? "selection" : "primary"}
                      onPress={() => setActiveDocumentPath(document.path)}
                    >
                      {document.path.split("/").pop()}
                      {document.dirty ? " *" : ""}
                    </Text>
                  ))}
                </Stack>
              </Panel>
            ) : null}
            {activeDocument ? (
              <EditorSurfaceView ref={editorRef} onSurfaceEvent={onEditorSurfaceEvent} />
            ) : (
              <Panel surface="panel" flex={1}>
                <Text tone="secondary">Open a file to begin editing.</Text>
              </Panel>
            )}
          </Stack>
        </Resizable>
        <Resizable edge="right" size={viewportWidth} onResize={setViewportWidth} minSize={280} maxSize={1600}>
          <ViewportSurfaceView ref={viewportRef} onSurfaceEvent={onViewportSurfaceEvent} />
        </Resizable>
        <PanelSection title="Diagnostics">
          <Panel surface="panel" flex={1} bordered>
            {diagnostics.length === 0 ? (
              <Text tone="secondary">No diagnostics.</Text>
            ) : (
              <ScrollView>
                {diagnostics.map((diagnostic, index) => (
                  <Text key={index} variant="label" tone={diagnostic.severity === "error" ? "action" : "secondary"}>
                    [{diagnostic.severity}] {diagnostic.message}
                  </Text>
                ))}
              </ScrollView>
            )}
          </Panel>
        </PanelSection>
      </Stack>
    </Stack>
  );
}

/**
 * A labeled, bordered region — every panel in the shell renders through
 * this so an empty one (e.g. diagnostics with nothing to report) still
 * reads as a real, bounded region rather than dead space blending into the
 * window background (RFD-19 "Layout and interaction": "Separate adjacent
 * regions with fine rules and slight tonal changes").
 */
function PanelSection({ title, children }: { readonly title: string; readonly children?: React.ReactNode }) {
  return (
    <Stack flex={1}>
      <Panel surface="panel" padding="xs" bordered>
        <Text variant="label" tone="secondary">
          {title.toUpperCase()}
        </Text>
      </Panel>
      <Stack flex={1}>{children}</Stack>
    </Stack>
  );
}

function WorkerHealthBadge({ health }: { health: WorkerHealth }) {
  switch (health.phase) {
    case "no_worker":
      return null;
    case "spawning":
    case "handshaking":
      return <StatusBadge tone="pending" label="Starting worker…" />;
    case "idle":
      return <StatusBadge tone="success" label="Worker ready" />;
    case "evaluating":
      return <StatusBadge tone="pending" label="Evaluating…" />;
    case "worker_unhealthy":
      return <StatusBadge tone="error" label="Worker unavailable" />;
    default:
      return null;
  }
}
