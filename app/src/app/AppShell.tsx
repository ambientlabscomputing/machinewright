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
import { ScrollView, View } from "react-native";
import { Button, Panel, Resizable, Stack, StatusBadge, Text } from "../design-system/native";
import { WorkerBridge } from "../native/WorkerBridge";
import { listFilesRecursive, readTextFile, searchInFiles, writeTextFileAtomically, type TextMatch } from "../native/BundledAssets";
import { watchProject } from "../native/ProjectWatcher";
import { focusedSurface, focusSurface, onShortcut, setInterceptedChords, type Surface } from "../native/Shortcuts";
import { CommandRegistry, type Command } from "../commands/registry";
import { matchByteRange, validateNewFilePath } from "../commands/textPosition";
import { CommandPalette, type PaletteHandle, type PaletteMode } from "./CommandPalette";
import { TerminalPanel, type TerminalPanelHandle } from "./TerminalPanel";
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
import { fromEditorDiagnostics, fromEvaluationFailure, mergeDiagnostics, type StructuredDiagnostic } from "../model/Diagnostics";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import { GraphTree } from "../graph/GraphTree";
import { buildGraphIndex } from "../graph/GraphIndex";
import { ExportCoordinator, type ExportJobInput, type ExportJobKind } from "../export/ExportCoordinator";
import { exportAssemblyFile } from "../export/assemblyExport";
import { selectedPartIds, type AssemblyFormat } from "../export/exportModel";
import { ExportDialog, type ExportTab } from "./ExportDialog";
import { PrintTab } from "./PrintTab";
import { BomTab } from "./BomTab";
import { EditorSurfaceView, type EditorSurfaceHandle } from "../editor/EditorHost";
import { ViewportSurfaceView, type ViewportSurfaceHandle } from "../viewport/ViewportHost";
import { InputsPanel, parseInputs, setInput, type InputValues } from "./InputsPanel";
import type { JsonSchemaNode } from "../analysis/inputSchema";
import { lspPositionToUtf8ByteOffset } from "../editor/offsets";
import { LspClient } from "../editor/LspClient";
import type { EditorDiagnostic, EditorSurfaceEvent } from "../protocol/surfaces/editor";
import type { ViewportSurfaceEvent } from "../protocol/surfaces/viewport";

function fileUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

function isPython(path: string): boolean {
  return /\.pyi?$/.test(path);
}

/** One project's worth of shared, long-lived state — constructed exactly once per "Open Project", disposed on close/switch. */
interface ProjectSession {
  readonly project: ProjectHandle;
  readonly documentStore: DocumentStore;
  readonly coordinator: EvaluationCoordinator;
  readonly snapshotStore: SnapshotStore;
  readonly snapshotInstaller: SnapshotInstaller;
  /** On-demand exports (parts, print plates) on the same worker as evaluation. */
  readonly exports: ExportCoordinator;
  /** A worker export request for the current inputs and unsaved edits, or `null` before a template is declared. */
  buildExportInput(kind: ExportJobKind, outputDirectory: string, options: unknown, basename: string): ExportJobInput | null;
  readonly lspClient: LspClient;
  readonly lspReady: Promise<boolean>;
  readonly pythonDiagnostics: Map<string, { text: string; items: readonly EditorDiagnostic[] }>;
  changeInput(path: readonly string[], value: unknown): void;
  resetInputs(): void;
  readonly outputDirectory: string;
  /** Mutable box, not React state: read by closures registered once at session-build time, so they always see the latest value without needing to be re-registered. */
  readonly environmentDigest: { current: string };
  readonly dispatchViewportEvent: (event: ViewportSurfaceEvent) => void;
  requestEvaluation(): void;
  dispose(): Promise<void>;
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

export type AppView = "workspace" | "print" | "bom";

export interface AppShellProps {
  /** Which app-level tab is showing; the workspace stays mounted underneath the print tab. */
  readonly view?: AppView;
  readonly onViewChange?: (view: AppView) => void;
}

export function AppShell({ view = "workspace", onViewChange }: AppShellProps = {}) {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const sessionRef = useRef<ProjectSession | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [health, setHealth] = useState<WorkerHealth>({ phase: "no_worker" });
  const [documents, setDocuments] = useState<readonly OpenDocument[]>([]);
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [snapshotVersion, setSnapshotVersion] = useState(0); // bumped on every SnapshotStore change, to re-derive the memos below
  const [inputSchema, setInputSchema] = useState<JsonSchemaNode | null>(null);
  const [inputValues, setInputValues] = useState<InputValues>({});
  const [inputError, setInputError] = useState<string | null>(null);
  const [canResetInputs, setCanResetInputs] = useState(false);
  const [exportDialog, setExportDialog] = useState<{ readonly tab: ExportTab; readonly nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Mounted on first visit, then kept (hidden) so its plate view and last run survive tab switches.
  const [printMounted, setPrintMounted] = useState(false);
  const [bomMounted, setBomMounted] = useState(false);
  useEffect(() => {
    if (view === "print") setPrintMounted(true);
    if (view === "bom") setBomMounted(true);
  }, [view]);
  const [lspStatus, setLspStatus] = useState<"starting" | "ready" | "unavailable">("starting");
  const navigation = useRef<{ path: string; offset: number; endOffset?: number } | null>(null);
  const [lspDiagnostics, setLspDiagnostics] = useState<readonly StructuredDiagnostic[]>([]);

  // Panel sizes are a UI preference, not machine-affecting state (RFD-19:
  // "The application may store camera positions, layout, recent files, and
  // other presentation preferences outside the package") — plain component
  // state is enough; nothing here is read by evaluation.
  const [explorerWidth, setExplorerWidth] = useState(260);
  const [explorerHeight, setExplorerHeight] = useState(280);
  const [editorWidth, setEditorWidth] = useState(560);
  const [inspectorWidth, setInspectorWidth] = useState(260);

  const viewportRef = useRef<ViewportSurfaceHandle>(null);
  // Viewport-maximized layout: every other region is collapsed/hidden but
  // stays mounted, so editor/terminal state (and the viewport's own scene)
  // survive toggling.
  const [viewportMaximized, setViewportMaximized] = useState(false);
  useEffect(() => {
    viewportRef.current?.setMaximized(viewportMaximized);
  }, [viewportMaximized]);
  const editorRef = useRef<EditorSurfaceHandle>(null);
  const generationRef = useRef<bigint>(0n);
  // Read by closures registered once at session-build time (the LSP
  // onDiagnostics callback), so they see the current active document
  // without needing to be re-registered on every switch.
  const activeDocumentPathRef = useRef<string | null>(null);
  activeDocumentPathRef.current = activeDocumentPath;

  const closeSession = useCallback(() => {
    const stopped = sessionRef.current?.dispose() ?? Promise.resolve();
    sessionRef.current = null;
    navigation.current = null;
    setSaveError(null);
    setSession(null);
    setInputSchema(null);
    setInputValues({});
    setInputError(null);
    setCanResetInputs(false);
    setLspStatus("starting");
    setDocuments([]);
    setActiveDocumentPath(null);
    setEditorReady(false);
    setSelection(EMPTY_SELECTION);
    setExportDialog(null);
    setHealth({ phase: "no_worker" });
    setLspDiagnostics([]);
    return stopped;
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

    const stopped = closeSession();

    const documentStore = new DocumentStore({
      projectRoot: project.rootPath,
      readFile: readTextFile,
      writeFile: writeTextFileAtomically,
    });
    const snapshotStore = new SnapshotStore();
    const transport = new WorkerBridge();
    const coordinator = new EvaluationCoordinator({
      transport,
      workerExecutablePath: project.workerExecutablePath,
    });
    let workerCapabilities: readonly string[] = [];
    const exports = new ExportCoordinator({ transport, capabilities: () => workerCapabilities });
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
    let configuredInputs: InputValues = {};
    let inputs: InputValues = {};
    let inputsReady = false;
    let disposed = false;
    const pythonDiagnostics: ProjectSession["pythonDiagnostics"] = new Map();
    const firstInput = project.config.inputConfigurations[0];
    const inputPath = firstInput ? defaultJoinPath(project.rootPath, firstInput) : null;

    function updateConfiguration(text: string) {
      try {
        configuredInputs = parseInputs(text);
        inputs = configuredInputs;
        setInputValues(inputs);
        setCanResetInputs(false);
        setInputError(null);
      } catch (error) {
        setInputError(`Input configuration: ${String(error)}`);
      }
    }

    const requestEvaluationNow = () => {
      if (disposed || !inputsReady) return;
      const template = project.config.templates[0];
      if (!template) return; // no declared template — nothing to evaluate against yet
      const input: EvaluationInput = {
        projectRoot: project.rootPath,
        templateId: template.id,
        templateVersion: template.version,
        inputsJson: new TextEncoder().encode(JSON.stringify(inputs)),
        outputDirectory,
        overlays: documentStore.overlaysForEvaluation(),
        environmentDigest: environmentDigest.current,
      };
      coordinator.requestEvaluation(input);
    };

    const buildExportInput: ProjectSession["buildExportInput"] = (kind, outputDirectory, options, basename) => {
      const template = project.config.templates[0];
      if (!template) return null;
      return {
        projectRoot: project.rootPath,
        templateId: template.id,
        templateVersion: template.version,
        inputsJson: new TextEncoder().encode(JSON.stringify(inputs)),
        overlays: documentStore.overlaysForEvaluation(),
        environmentDigest: environmentDigest.current,
        kind,
        outputDirectory,
        options,
        basename,
      };
    };

    const unsubscribeHealth = coordinator.onHealthChange((nextHealth) => {
      if (nextHealth.phase === "idle" || nextHealth.phase === "evaluating") workerCapabilities = nextHealth.capabilities;
      setHealth(nextHealth);
      if (nextHealth.phase === "worker_unhealthy") snapshotStore.setWorkerUnhealthy();
    });
    const unsubscribeOutcome = coordinator.onOutcome((outcome) => {
      if (outcome.kind === "completed") {
        void snapshotInstaller.stage(outcome.result, outputDirectory);
      } else if (outcome.kind === "inputSchema") {
        setInputSchema(JSON.parse(new TextDecoder().decode(outcome.schemaJson)) as JsonSchemaNode);
      } else if (outcome.kind === "failed") {
        snapshotStore.setFailed(outcome.failure.generation, outcome.failure);
      }
    });
    const unsubscribeSnapshot = snapshotStore.subscribe(() => setSnapshotVersion((v) => v + 1));
    const unsubscribeDocuments = documentStore.onChange(({ document }) => {
      if (document.path === inputPath) updateConfiguration(document.bufferContent);
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

    void stopped.then(() => inputPath ? readTextFile(inputPath) : "{}")
      .then((text) => {
        if (!disposed) updateConfiguration(inputPath ? documentStore.get(inputPath)?.bufferContent ?? text : text);
      })
      .catch((error: unknown) => {
        if (!disposed) setInputError(`Could not read input configuration: ${String(error)}`);
      })
      .finally(() => {
        inputsReady = true;
        requestEvaluationNow();
      });

    lspClient.onExit = () => {
      if (!disposed) setLspStatus("unavailable");
    };
    const lspReady = stopped.then(async () => {
      if (disposed) return false;
      try {
        await lspClient.start(project.lspExecutablePath, fileUri(project.rootPath));
        if (!disposed) setLspStatus("ready");
        return !disposed;
      } catch {
        if (!disposed) setLspStatus("unavailable");
        return false;
      }
    });
    lspClient.onDiagnostics = (uri, text, items) => {
      if (disposed) return;
      const path = decodeURIComponent(uri.slice("file://".length));
      const document = documentStore.get(path);
      if (document?.bufferContent !== text) return;
      pythonDiagnostics.set(path, { text, items });
      if (path === activeDocumentPathRef.current) {
        setLspDiagnostics(fromEditorDiagnostics(items, path));
        editorRef.current?.setDiagnostics(path, document.documentVersion, items);
      }
    };

    const newSession: ProjectSession = {
      project,
      documentStore,
      coordinator,
      snapshotStore,
      snapshotInstaller,
      exports,
      buildExportInput,
      lspClient,
      lspReady,
      pythonDiagnostics,
      changeInput: (path, value) => {
        inputs = setInput(inputs, path, value);
        setInputValues(inputs);
        setCanResetInputs(true);
        requestEvaluationNow();
      },
      resetInputs: () => {
        inputs = configuredInputs;
        setInputValues(inputs);
        setCanResetInputs(false);
        requestEvaluationNow();
      },
      outputDirectory,
      environmentDigest,
      dispatchViewportEvent,
      requestEvaluation: requestEvaluationNow,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        unsubscribeHealth();
        unsubscribeOutcome();
        unsubscribeSnapshot();
        unsubscribeDocuments();
        snapshotInstaller.dispose();
        exports.dispose();
        coordinator.dispose();
        await Promise.allSettled([lspClient.stop(), transport.stop()]);
      },
    };
    sessionRef.current = newSession;
    setSession(newSession);
  }, [closeSession]);

  useEffect(() => {
    // Cleanup should only run when `session` itself changes (project
    // opened/closed/replaced) — that identity is exactly what should
    // trigger disposing the previous one, so it is the right and only
    // dependency here.
    return () => { void session?.dispose(); };
  }, [session]);

  /** Shared by the "Open File" native picker and `FileExplorer`'s click-to-open. */
  const openFileAtPath = useCallback(
    async (path: string) => {
      if (!session) return;
      await session.documentStore.open(path);
      if (sessionRef.current !== session) return;
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
    setSaveError(null);
    void session.documentStore.save(activeDocumentPath).then(
      () => {
        if (sessionRef.current !== session) return;
        setSaveError(null);
        setDocuments(session.documentStore.listOpen());
        if (session.documentStore.projectRelativePath(activeDocumentPath)) {
          session.requestEvaluation();
        }
      },
      (error: unknown) => {
        if (sessionRef.current === session) {
          setSaveError(`Could not save ${activeDocumentPath}: ${String(error)}`);
        }
      },
    );
  }, [session, activeDocumentPath]);

  const currentSnapshot = useMemo(() => session?.snapshotStore.getAccepted() ?? null, [session, snapshotVersion]);
  const currentStatus = useMemo(
    () => session?.snapshotStore.getStatus() ?? ({ kind: "idle" } as const),
    [session, snapshotVersion],
  );
  const diagnostics = useMemo(
    () => mergeDiagnostics(
      currentSnapshot?.diagnostics ?? [],
      currentStatus.kind === "failed" ? [fromEvaluationFailure(currentStatus.failure)] : [],
      lspDiagnostics,
    ),
    [currentSnapshot, currentStatus, lspDiagnostics],
  );

  const activeDocument = documents.find((d) => d.path === activeDocumentPath) ?? null;

  /** `activeDocumentPath` relative to the open project's root — what `SourceSpan.path`/`SourceMapping` actually key on. */
  const activeRelativePath = useMemo(() => {
    if (!session || !activeDocumentPath) return null;
    return session.documentStore.projectRelativePath(activeDocumentPath);
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
      if (!session || event.path !== activeDocumentPath) return;
      if (event.kind === "saveRequested") {
        if (session.documentStore.get(event.path)?.dirty) saveActiveDocument();
      } else if (event.kind === "languageQuery") {
        const document = session.documentStore.get(event.path);
        void (async () => {
          let response: Awaited<ReturnType<LspClient["query"]>> = null;
          try {
            if (!session.documentStore.projectRelativePath(event.path) || !(await session.lspReady) || sessionRef.current !== session ||
                document?.documentVersion !== event.documentVersion ||
                session.documentStore.get(event.path)?.documentVersion !== event.documentVersion) return;
            const uri = fileUri(event.path);
            await session.lspClient.didOpen(uri, "python", document.bufferContent);
            const result = await session.lspClient.query(uri, event.query, event.position);
            if (sessionRef.current !== session || activeDocumentPathRef.current !== event.path ||
                session.documentStore.get(event.path)?.documentVersion !== event.documentVersion) return;
            if (result?.kind === "definition" && result.uri.startsWith("file:///")) {
              const path = decodeURIComponent(result.uri.slice("file://".length));
              const target = await session.documentStore.open(path);
              if (sessionRef.current !== session || activeDocumentPathRef.current !== event.path ||
                  session.documentStore.get(event.path)?.documentVersion !== event.documentVersion) return;
              const offset = lspPositionToUtf8ByteOffset(target.bufferContent, result.position);
              if (path === event.path) {
                editorRef.current?.setSelection(path, { startByte: offset, endByte: offset });
              } else {
                navigation.current = { path, offset };
                setDocuments(session.documentStore.listOpen());
                setActiveDocumentPath(path);
              }
            } else {
              response = result;
            }
          } catch {
            // A timed-out or unsupported language query must leave the editor usable.
          } finally {
            if (sessionRef.current === session) editorRef.current?.languageResult(event.id, response);
          }
        })();
      } else if (event.kind === "documentChanged") {
        session.documentStore.applyChange(event.path, event.content, event.origin);
        if (isPython(event.path)) {
          void session.lspReady.then((ready) => {
            if (ready && sessionRef.current === session) {
              const latest = session.documentStore.get(event.path);
              if (latest) return session.lspClient.didOpen(fileUri(event.path), "python", latest.bufferContent);
            }
          }).catch(() => {});
        }
      } else if (event.kind === "selectionChanged" && currentSnapshot && activeRelativePath) {
        const nodeIds = resolveNodeIdsInMappings(currentSnapshot.sourceMap, activeRelativePath, event.range.startByte);
        if (nodeIds.length > 0) {
          const next = selectionOfNodes(nodeIds);
          setSelection(next);
          viewportRef.current?.setSelection(generationRef.current, next.nodeIds, next.primaryNodeId);
        }
      }
    },
    [session, activeDocumentPath, currentSnapshot, activeRelativePath, saveActiveDocument],
  );

  const onViewportSurfaceEvent = useCallback(
    (event: ViewportSurfaceEvent) => {
      session?.dispatchViewportEvent(event);
      if (event.kind === "toggleMaximize") setViewportMaximized((value) => !value);
      // A freshly (re)loaded viewport surface has no layout state yet.
      if (event.kind === "ready") viewportRef.current?.setMaximized(viewportMaximized);
      if (event.kind === "pickResult" && event.graphNodeId) {
        generationRef.current = event.generation;
        setSelection(selectionOfNode(event.graphNodeId));
        highlightNodeInEditor(event.graphNodeId);
      }
    },
    [session, highlightNodeInEditor, viewportMaximized],
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
    const target = navigation.current;
    if (target?.path === document.path) {
      navigation.current = null;
      editorRef.current?.setSelection(target.path, { startByte: target.offset, endByte: target.endOffset ?? target.offset });
    }
    const previous = session.pythonDiagnostics.get(document.path);
    const items = previous?.text === document.bufferContent ? previous.items : [];
    setLspDiagnostics(fromEditorDiagnostics(items, document.path));
    editorRef.current?.setDiagnostics(document.path, document.documentVersion, items);
    if (isPython(document.path) && session.documentStore.projectRelativePath(document.path)) {
      void session.lspReady.then((ready) => {
        if (ready && sessionRef.current === session) {
          const latest = session.documentStore.get(document.path);
          if (latest) return session.lspClient.didOpen(fileUri(document.path), "python", latest.bufferContent);
        }
      }).catch(() => {});
    }
  }, [editorReady, session, activeDocumentPath]);

  const onSelectGraphNode = useCallback(
    (next: Selection) => {
      setSelection(next);
      viewportRef.current?.setSelection(generationRef.current, next.nodeIds, next.primaryNodeId);
      if (next.primaryNodeId) highlightNodeInEditor(next.primaryNodeId);
    },
    [highlightNodeInEditor],
  );

  const showNodesInViewport = useCallback(
    (nodeIds: readonly string[]) => {
      onViewChange?.("workspace");
      onSelectGraphNode({ nodeIds, primaryNodeId: nodeIds[0] ?? null });
    },
    [onSelectGraphNode, onViewChange],
  );

  // --- Command palette, keyboard shortcuts, in-window terminal -------------
  // Shortcuts are intercepted natively (they must work while a WebView owns
  // focus) and dispatched through one `CommandRegistry`; the palette lists
  // the same registry. See src/commands and MachinewrightShortcutsModule.
  const [palette, setPalette] = useState<{ mode: PaletteMode; nonce: number } | null>(null);
  const paletteOpen = palette !== null;
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteOpen;
  const paletteRef = useRef<PaletteHandle>(null);
  const paletteNonce = useRef(0);
  const surfaceBeforePalette = useRef<Surface | null>(null);
  const [projectFiles, setProjectFiles] = useState<readonly string[] | null>(null);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const terminalRef = useRef<TerminalPanelHandle>(null);
  const terminalOpenRef = useRef(false);
  terminalOpenRef.current = terminalOpen;

  const focusEditor = useCallback(() => {
    void focusSurface("editor");
    editorRef.current?.focus();
  }, []);

  const refreshProjectFiles = useCallback(() => {
    if (!session) return;
    listFilesRecursive(session.project.rootPath).then(
      (paths) => {
        if (sessionRef.current === session) setProjectFiles(paths);
      },
      () => {
        if (sessionRef.current === session) setProjectFiles([]);
      },
    );
  }, [session]);

  useEffect(() => {
    setProjectFiles(null);
    refreshProjectFiles();
  }, [refreshProjectFiles]);

  // Stay live with the disk: files created/removed outside the app (the
  // terminal, git, another editor) refresh the explorer and the quick-open
  // index. Bursts (git checkout, npm install) are coalesced for the index.
  const [fsChange, setFsChange] = useState<{ readonly paths: readonly string[] } | null>(null);
  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = watchProject(session.project.rootPath, (paths) => {
      setFsChange({ paths });
      clearTimeout(timer);
      timer = setTimeout(refreshProjectFiles, 400);
    });
    return () => {
      stop();
      clearTimeout(timer);
      setFsChange(null);
    };
  }, [session, refreshProjectFiles]);

  const openPalette = useCallback((mode: PaletteMode) => {
    const show = () => {
      paletteNonce.current += 1;
      setPalette({ mode, nonce: paletteNonce.current });
    };
    if (paletteOpenRef.current) {
      show(); // re-trigger while open: just switch mode, keep the original focus target
      return;
    }
    // Remember which surface had focus so closing the palette can hand it back.
    focusedSurface().then(
      (surface) => {
        surfaceBeforePalette.current = surface;
        show();
      },
      () => {
        surfaceBeforePalette.current = null;
        show();
      },
    );
  }, []);

  const closePalette = useCallback(
    (restoreFocus = true) => {
      setPalette(null);
      if (!restoreFocus) return;
      const surface = surfaceBeforePalette.current;
      setTimeout(() => {
        if (surface === "terminal" && terminalOpenRef.current) terminalRef.current?.focus();
        else focusEditor();
      }, 50);
    },
    [focusEditor],
  );

  const openFileFromPalette = useCallback(
    async (relativePath: string, match?: TextMatch) => {
      if (!session) return;
      closePalette(false);
      const absolute = defaultJoinPath(session.project.rootPath, relativePath);
      try {
        const document = await session.documentStore.open(absolute);
        if (sessionRef.current !== session) return;
        const range = match ? matchByteRange(document.bufferContent, match.line, match.column, match.length) : null;
        if (range && absolute === activeDocumentPathRef.current) {
          editorRef.current?.setSelection(absolute, range);
        } else {
          if (range) navigation.current = { path: absolute, offset: range.startByte, endOffset: range.endByte };
          setDocuments(session.documentStore.listOpen());
          setActiveDocumentPath(absolute);
        }
        setTimeout(focusEditor, 150);
      } catch (error) {
        setOpenError(`Could not open ${relativePath}: ${String(error)}`);
      }
    },
    [session, closePalette, focusEditor],
  );

  const searchProjectText = useCallback(
    (query: string) => {
      if (!session) return Promise.resolve([]);
      // Smart case: an upper-case letter in the query makes the search case-sensitive.
      return searchInFiles(session.project.rootPath, query, { caseSensitive: /[A-Z]/.test(query) });
    },
    [session],
  );

  const createFile = useCallback(
    async (input: string) => {
      if (!session) throw new Error("Open a project first");
      const relative = validateNewFilePath(input);
      const absolute = defaultJoinPath(session.project.rootPath, relative);
      let exists = true;
      try {
        await readTextFile(absolute);
      } catch {
        exists = false;
      }
      // Never overwrite: an existing file is simply opened.
      if (!exists) await writeTextFileAtomically(absolute, "");
      if (sessionRef.current !== session) return;
      setProjectFiles((current) => (current && !current.includes(relative) ? [...current, relative] : current));
      await openFileAtPath(absolute);
      surfaceBeforePalette.current = "editor"; // the palette closes right after this resolves
    },
    [session, openFileAtPath],
  );

  const toggleTerminal = useCallback(() => {
    if (terminalOpenRef.current) {
      setTerminalOpen(false);
      setTimeout(focusEditor, 50);
    } else {
      setTerminalMounted(true);
      setTerminalOpen(true);
    }
  }, [focusEditor]);

  // Whenever the terminal becomes visible it takes focus (deferred inside
  // the panel until its surface has loaded, on first open).
  useEffect(() => {
    if (terminalOpen && terminalMounted) terminalRef.current?.focus();
  }, [terminalOpen, terminalMounted]);

  const graphIndex = useMemo(() => (currentSnapshot ? buildGraphIndex(currentSnapshot.graph) : null), [currentSnapshot]);
  const selectedParts = useMemo(
    () => (graphIndex ? selectedPartIds(graphIndex, selection.nodeIds) : []),
    [graphIndex, selection],
  );
  const exportNonce = useRef(0);
  const openExportDialog = useCallback((tab: ExportTab) => {
    exportNonce.current += 1;
    setExportDialog({ tab, nonce: exportNonce.current });
  }, []);

  // Whole-assembly export straight from the command palette: ask where, copy
  // the file the last evaluation already wrote, and say what happened.
  const quickExportAssembly = useCallback(
    async (format: AssemblyFormat) => {
      if (!session || !currentSnapshot) return;
      const result = await exportAssemblyFile({
        outputDirectory: session.outputDirectory,
        graphDigest: currentSnapshot.graphDigest,
        projectId: session.project.config.projectId,
        format,
      });
      if (result.kind === "saved") setNotice(`Exported ${result.path}`);
    },
    [session, currentSnapshot],
  );
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const hasProject = session !== null;
  const hasSnapshot = currentSnapshot !== null;
  const hasActiveDocument = activeDocument !== null;
  const activeDocumentDirty = activeDocument?.dirty === true;
  const registry = useMemo(
    () =>
      new CommandRegistry([
        {
          id: "palette.commands",
          category: "View",
          title: "Show All Commands",
          shortcut: "Cmd+Shift+P",
          run: () => openPalette({ kind: "list", initialQuery: ">" }),
        },
        { id: "file.openProject", category: "File", title: "Open Project…", shortcut: "Cmd+O", run: () => openProject() },
        {
          id: "file.quickOpen",
          category: "File",
          title: "Go to File…",
          shortcut: "Cmd+P",
          run: () => {
            refreshProjectFiles();
            openPalette({ kind: "list", initialQuery: "" });
          },
        },
        {
          id: "file.new",
          category: "File",
          title: "New File…",
          shortcut: "Cmd+N",
          enabled: hasProject,
          run: () =>
            openPalette({
              kind: "prompt",
              title: "New file — path relative to the project root",
              placeholder: "parts/bracket.py",
              initialValue: "",
              onSubmit: createFile,
            }),
        },
        { id: "file.openFromDisk", category: "File", title: "Open File from Disk…", enabled: hasProject, run: () => openFile() },
        { id: "file.save", category: "File", title: "Save File", enabled: activeDocumentDirty, run: () => saveActiveDocument() },
        {
          id: "find.inFile",
          category: "Find",
          title: "Find in File",
          shortcut: "Cmd+F",
          enabled: hasActiveDocument,
          run: () => {
            focusEditor();
            editorRef.current?.openFind();
          },
        },
        {
          id: "find.inFiles",
          category: "Find",
          title: "Find in Files…",
          shortcut: "Cmd+Shift+F",
          run: () => openPalette({ kind: "list", initialQuery: "%" }),
        },
        { id: "terminal.toggle", category: "View", title: "Toggle Terminal", shortcut: "Cmd+J", run: toggleTerminal },
        {
          id: "terminal.clear",
          category: "Terminal",
          title: "Clear Terminal",
          enabled: terminalMounted,
          run: () => terminalRef.current?.clear(),
        },
        {
          id: "view.toggleMaximizeViewport",
          category: "View",
          title: "Toggle Maximized Viewport",
          enabled: true,
          run: () => setViewportMaximized((value) => !value),
        },
        { id: "view.fitCamera", category: "View", title: "Fit Camera", enabled: hasProject, run: () => viewportRef.current?.fitCamera() },
        { id: "export.dialog", category: "Export", title: "Export…", shortcut: "Cmd+Shift+E", enabled: hasProject, run: () => openExportDialog("assembly") },
        { id: "export.step", category: "Export", title: "Export Assembly as STEP…", enabled: hasSnapshot, run: () => quickExportAssembly("step") },
        { id: "export.stl", category: "Export", title: "Export Assembly as STL…", enabled: hasSnapshot, run: () => quickExportAssembly("stl") },
        { id: "export.parts", category: "Export", title: "Export Parts…", enabled: hasProject, run: () => openExportDialog("parts") },
        { id: "export.print", category: "Export", title: "Open 3D Print Plates", enabled: hasProject, run: () => onViewChange?.("print") },
        { id: "bom.open", category: "View", title: "Open Purchased Parts BOM", enabled: hasProject, run: () => onViewChange?.("bom") },
        { id: "worker.retry", category: "Worker", title: "Retry Worker", enabled: hasProject, run: () => session?.coordinator.retry() },
      ]),
    [
      openPalette, openProject, refreshProjectFiles, createFile, openFile, saveActiveDocument, focusEditor,
      toggleTerminal, hasProject, hasSnapshot, hasActiveDocument, activeDocumentDirty, terminalMounted, session,
      openExportDialog, quickExportAssembly, onViewChange,
    ],
  );
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const runPaletteCommand = useCallback(
    (command: Command) => {
      closePalette(false); // the command decides where focus goes next
      Promise.resolve(command.run()).catch((error: unknown) => setOpenError(String(error)));
    },
    [closePalette],
  );

  useEffect(
    () =>
      onShortcut((chord) => {
        if (paletteOpenRef.current) {
          if (chord === "Escape") return closePalette();
          if (chord === "Up") return paletteRef.current?.move(-1);
          if (chord === "Down") return paletteRef.current?.move(1);
        }
        registryRef.current.runChord(chord).catch((error: unknown) => setOpenError(String(error)));
      }),
    [closePalette],
  );

  useEffect(() => {
    setInterceptedChords([...registry.enabledShortcutChords(), ...(paletteOpen ? ["Escape", "Up", "Down"] : [])]);
  }, [registry, paletteOpen]);
  useEffect(() => () => setInterceptedChords([]), []);

  return (
    <Panel surface="workspace" padding="none" flex={1}>
      <View style={viewportMaximized ? { display: "none" } : null}>
      <Panel surface="panel" padding="sm">
        <Stack direction="row" gap="sm" align="center">
          <Button label="Commands" onPress={() => void registry.run("palette.commands")} />
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
          <Button label="Export" onPress={() => openExportDialog("assembly")} disabled={!session} />
          <Text variant="label" tone="secondary">
            {session ? session.project.config.projectId : "No project open"}
          </Text>
          <WorkerHealthBadge health={health} />
          {activeDocumentPath && isPython(activeDocumentPath) ? (
            <StatusBadge tone={lspStatus === "unavailable" ? "error" : lspStatus === "starting" ? "pending" : "success"}
              label={lspStatus === "unavailable" ? "Python LSP unavailable" : lspStatus === "starting" ? "Starting Python LSP…" : "Python LSP"} />
          ) : null}
          {currentStatus.kind === "pending" ? <StatusBadge tone="pending" label="Evaluating…" /> : null}
          {currentStatus.kind === "failed" ? <StatusBadge tone="error" label="Evaluation failed" /> : null}
          {openError ? <Text tone="secondary">{openError}</Text> : null}
          {notice ? <Text variant="label" tone="secondary">{notice}</Text> : null}
        </Stack>
        {saveError ? <Text tone="primary">{saveError}</Text> : null}
      </Panel>
      </View>
      <Stack flex={1}>
      <Stack direction="row" flex={1}>
        <Resizable edge="right" size={explorerWidth} onResize={setExplorerWidth} minSize={180} maxSize={520} collapsed={viewportMaximized}>
          <Stack flex={1}>
            <Resizable edge="bottom" size={explorerHeight} onResize={setExplorerHeight} minSize={120} maxSize={800}>
              <PanelSection title="Files">
                {session ? (
                  <FileExplorer
                    rootPath={session.project.rootPath}
                    activeFilePath={activeDocumentPath}
                    onOpenFile={(path) => void openFileAtPath(path)}
                    change={fsChange}
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
        <Resizable edge="right" size={editorWidth} onResize={setEditorWidth} minSize={280} maxSize={1400} collapsed={viewportMaximized}>
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
        <Stack flex={1}>
          <ViewportSurfaceView ref={viewportRef} onSurfaceEvent={onViewportSurfaceEvent} />
        </Stack>
        <Resizable edge="left" size={inspectorWidth} onResize={setInspectorWidth} minSize={220} maxSize={440} collapsed={viewportMaximized}>
          <Stack flex={1}>
            <PanelSection title="Inputs">
              <InputsPanel schema={inputSchema} values={inputValues} error={inputError} canReset={canResetInputs}
                onChange={(path, value) => session?.changeInput(path, value)} onReset={() => session?.resetInputs()} />
            </PanelSection>
            <PanelSection title="Diagnostics">
              <Panel surface="panel" flex={1} bordered>
                {session && activeDocumentPath && isPython(activeDocumentPath) && lspStatus === "unavailable" ? (
                  <Text tone="secondary">Python language server unavailable. Install pylsp in the project environment, then reopen the project.</Text>
                ) : null}
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
        </Resizable>
      </Stack>
      {terminalMounted ? (
        <Resizable
          edge="top"
          size={terminalHeight}
          onResize={setTerminalHeight}
          minSize={120}
          maxSize={700}
          collapsed={!terminalOpen || viewportMaximized}
        >
          <TerminalPanel ref={terminalRef} cwd={session?.project.rootPath ?? ""} />
        </Resizable>
      ) : null}
      </Stack>
      {exportDialog && session ? (
        <ExportDialog
          key={exportDialog.nonce}
          initialTab={exportDialog.tab}
          projectId={session.project.config.projectId}
          projectRoot={session.project.rootPath}
          outputDirectory={session.outputDirectory}
          graphDigest={currentSnapshot?.graphDigest ?? null}
          selection={selectedParts}
          coordinator={session.exports}
          buildJobInput={session.buildExportInput}
          onClose={() => setExportDialog(null)}
        />
      ) : null}
      {printMounted && session ? (
        <View
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, display: view === "print" ? "flex" : "none" }}
        >
          <Panel surface="display" padding="none" flex={1}>
            <PrintTab key={session.project.rootPath} projectRoot={session.project.rootPath} coordinator={session.exports} buildJobInput={session.buildExportInput} />
          </Panel>
        </View>
      ) : null}
      {bomMounted && session ? (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, display: view === "bom" ? "flex" : "none" }}>
          <Panel surface="display" padding="none" flex={1}>
            <BomTab
              key={session.project.rootPath}
              projectId={session.project.config.projectId}
              projectRoot={session.project.rootPath}
              outputDirectory={session.outputDirectory}
              graphDigest={currentSnapshot?.graphDigest ?? null}
              onShowInViewport={showNodesInViewport}
              coordinator={session.exports}
              buildJobInput={session.buildExportInput}
            />
          </Panel>
        </View>
      ) : null}
      {palette ? (
        <CommandPalette
          key={palette.nonce}
          ref={paletteRef}
          mode={palette.mode}
          commands={registry.listEnabled()}
          files={projectFiles}
          hasProject={hasProject}
          onClose={() => closePalette()}
          onRunCommand={runPaletteCommand}
          onOpenFile={(relativePath) => void openFileFromPalette(relativePath)}
          onOpenMatch={(match) => void openFileFromPalette(match.path, match)}
          onSearchText={searchProjectText}
        />
      ) : null}
    </Panel>
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
