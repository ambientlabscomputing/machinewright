/**
 * RFD-19 M3 vertical slice: end-to-end proof that the "Hardware function
 * laboratory" pieces (SweepCoordinator's worker pool, SweepSnapshotCache,
 * the analysis WebView chart, ControlPanel/SweepDomainPanel) compose into a
 * real, runnable screen — the same "architecture spike proves the runtime
 * before expanding product features" approach RFD-19's M1 spike used, kept
 * reachable under Dev Tools exactly like ViewportHost/EditorHost/
 * SelectionSyncSpike (B.2-B.5) rather than folded into `AppShell` yet.
 *
 * Selecting a sweep point here installs into a real `SnapshotStore`/
 * `SnapshotInstaller` pair and re-renders both `ViewportSurfaceView` and
 * `GraphTree` from it — proving M3's "load graph and geometry snapshots for
 * selected evaluation points" is the same "install a newer accepted
 * snapshot" mechanism M2 already built, not a parallel one.
 *
 * The reference template's input schema is inlined rather than fetched at
 * runtime: the worker protocol has no "describe this template's inputs"
 * request today (only `EvaluateProject`/`EvaluateSweepPoint`), and adding
 * one is out of scope for M3 (`input_schema()` is already exercised
 * headlessly via the `machinewright project schema` CLI command). This
 * schema is copied verbatim from that command's actual output for
 * `machinewright.reference.simple@1.0.0`.
 */
import { useRef, useState } from "react";
import type { RefObject } from "react";
import { Stack } from "../design-system/native";
import { readTextFile } from "../native/BundledAssets";
import { createNativeCacheClient } from "../cache/nativeCacheClient";
import { SnapshotStore } from "../model/SnapshotStore";
import { EMPTY_SELECTION, type Selection } from "../model/Selection";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import { SnapshotInstaller, type ViewportSurfacePort } from "../evaluator/SnapshotInstaller";
import { GraphTree } from "../graph/GraphTree";
import { ViewportSurfaceView, type ViewportSurfaceHandle } from "../viewport/ViewportHost";
import type { ViewportSurfaceEvent } from "../protocol/surfaces/viewport";
import { SweepView } from "../analysis/SweepView";
import type { JsonSchemaNode } from "../analysis/inputSchema";

/** Same bridge `app/AppShell.tsx`'s `buildViewportSurfacePort` uses: a
 * `ViewportSurfacePort` whose `onEvent` actually forwards events from the
 * real `ViewportSurfaceView` (via the returned `dispatch`), rather than a
 * stub that silently drops them — `SnapshotInstaller` never sees a
 * "prepared" event otherwise, so it never calls `snapshotStore.install()`
 * and a selected point's graph/geometry never actually appears. */
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

const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const WORKER_PATH = `${REPO_ROOT}/.venv/bin/machinewright-worker`;
const OUTPUT_DIRECTORY = "/tmp/machinewright-app-behavior-lab-spike";

// Verbatim `uv run python -c "...reference_machine...input_schema()..."` output.
const REFERENCE_INPUT_SCHEMA: JsonSchemaNode = {
  type: "object",
  properties: {
    requirements: {
      type: "object",
      title: "ReferenceInputs",
      properties: {
        schema_version: { const: "1.0", default: "1.0", title: "Schema Version", type: "string" },
        payload_kg: {
          type: "number",
          title: "Payload Kg",
          default: 10.0,
          exclusiveMinimum: 0,
          maximum: 100,
        },
      },
    },
  },
};

async function loadSnapshotJson(snapshotPath: string): Promise<EvaluationSnapshot> {
  return JSON.parse(await readTextFile(snapshotPath)) as EvaluationSnapshot;
}

export function BehaviorLabSpike() {
  const [graph, setGraph] = useState<EvaluationSnapshot["graph"] | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const viewportRef = useRef<ViewportSurfaceHandle>(null);

  const snapshotStoreRef = useRef<SnapshotStore | null>(null);
  if (snapshotStoreRef.current === null) snapshotStoreRef.current = new SnapshotStore();
  const snapshotStore = snapshotStoreRef.current;

  const cacheClientRef = useRef(createNativeCacheClient());

  const viewportBridgeRef = useRef<ReturnType<typeof buildViewportSurfacePort> | null>(null);
  if (viewportBridgeRef.current === null) {
    viewportBridgeRef.current = buildViewportSurfacePort(viewportRef);
  }

  const installerRef = useRef<SnapshotInstaller | null>(null);
  if (installerRef.current === null) {
    installerRef.current = new SnapshotInstaller({
      viewport: viewportBridgeRef.current.port,
      snapshotStore,
      cacheClient: cacheClientRef.current,
      loadEvaluationSnapshot: loadSnapshotJson,
    });
    snapshotStore.subscribe(() => {
      const accepted = snapshotStore.getAccepted();
      setGraph(accepted?.graph ?? null);
      if (accepted !== null) {
        viewportRef.current?.setSelection(accepted.generation, [], null);
      }
    });
  }

  return (
    <Stack direction="row" flex={1}>
      <Stack flex={1}>
        <SweepView
          projectRoot={REPO_ROOT}
          workerExecutablePath={WORKER_PATH}
          templateId="machinewright.reference.simple"
          templateVersion="1.0.0"
          baselineInputs={{ requirements: { payload_kg: 10.0 } }}
          outputDirectory={OUTPUT_DIRECTORY}
          inputSchema={REFERENCE_INPUT_SCHEMA}
          installer={installerRef.current}
          cacheClient={cacheClientRef.current}
          loadEvaluationSnapshot={loadSnapshotJson}
        />
      </Stack>
      <Stack flex={1}>
        <ViewportSurfaceView ref={viewportRef} onSurfaceEvent={viewportBridgeRef.current.dispatch} />
        <GraphTree
          graph={graph}
          selection={selection}
          onSelectNode={(next) => setSelection(next)}
        />
      </Stack>
    </Stack>
  );
}
