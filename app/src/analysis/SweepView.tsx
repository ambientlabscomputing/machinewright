/**
 * RFD-19 M3 "Hardware function laboratory" screen: generate controls from
 * the template's typed inputs, run a cancellable 1D/2D sweep across a small
 * worker pool, display the resulting behavior chart, and select a point to
 * load its graph/geometry snapshot.
 *
 * Selecting a point does not enter a separate "sweep view mode" for the
 * viewport or graph panel: it installs into the very same `SnapshotStore`
 * the main editor uses, via `SweepSnapshotCache`/`SnapshotInstaller.
 * stagePreloaded` (see model/SweepSnapshotCache.ts's doc comment for why
 * that needs its own "view generation" counter). This component therefore
 * takes the session's existing `installer`/`cacheClient`/
 * `loadEvaluationSnapshot` as props rather than constructing its own —
 * there is exactly one accepted snapshot per project, sweep or not.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, Stack, StatusBadge, Text } from "../design-system/native";
import { WorkerBridge } from "../native/WorkerBridge";
import { SweepCoordinator, type SweepPointOutcome } from "../evaluator/SweepCoordinator";
import { SweepSnapshotCache, type SweepInstallerPort } from "../model/SweepSnapshotCache";
import type { CacheClient } from "../cache/CacheClient";
import type { EvaluationSnapshot } from "../model/generated/EvaluationSnapshot";
import { ControlPanel } from "./ControlPanel";
import { SweepDomainPanel } from "./SweepDomainPanel";
import { AnalysisSurfaceView, type AnalysisSurfaceHandle } from "./AnalysisSurfaceView";
import type { JsonSchemaNode } from "./inputSchema";
import { gridSweepPoints, linearSweepPoints, type SweepAxis } from "./sweepDomain";
import type { SweepPointChartDatum } from "../protocol/surfaces/analysis";
import type { AnalysisSurfaceEvent } from "../protocol/surfaces/analysis";

export interface SweepViewProps {
  readonly projectRoot: string;
  readonly workerExecutablePath: string;
  readonly templateId: string;
  readonly templateVersion: string;
  /** The main editor's current point values, as a JSON object (not yet UTF-8-encoded) — sweep axes override these dotted paths, everything else stays at this baseline. */
  readonly baselineInputs: Readonly<Record<string, unknown>>;
  readonly outputDirectory: string;
  readonly inputSchema: JsonSchemaNode;
  readonly installer: SweepInstallerPort;
  readonly cacheClient: CacheClient;
  readonly loadEvaluationSnapshot: (snapshotPath: string) => Promise<EvaluationSnapshot>;
}

type SweepStatus =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly completed: number; readonly total: number }
  | { readonly phase: "done"; readonly completed: number; readonly total: number };

function setDottedPath(target: Record<string, unknown>, path: string, value: number): Record<string, unknown> {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(target));
  const segments = path.split(".");
  let cursor: Record<string, unknown> = clone;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    const child: Record<string, unknown> = typeof next === "object" && next !== null ? { ...(next as Record<string, unknown>) } : {};
    cursor[segment] = child;
    cursor = child;
  }
  cursor[segments[segments.length - 1]!] = value;
  return clone;
}

function toObservableDatum(raw: EvaluationSnapshot["observables"]): SweepPointChartDatum["observables"] {
  return (raw ?? []).map((observable) => ({
    observableId: observable.observable_id,
    kind: observable.kind,
    label: observable.label,
    value: observable.value,
    unit: observable.unit ?? null,
    feasible: observable.feasible ?? null,
  }));
}

export function SweepView(props: SweepViewProps) {
  const {
    projectRoot,
    workerExecutablePath,
    templateId,
    templateVersion,
    baselineInputs,
    outputDirectory,
    inputSchema,
    installer,
    cacheClient,
    loadEvaluationSnapshot,
  } = props;

  const [pointValues, setPointValues] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<SweepStatus>({ phase: "idle" });
  const [points, setPoints] = useState<SweepPointChartDatum[]>([]);
  const [axesUsed, setAxesUsed] = useState<readonly string[]>([]);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const analysisSurfaceRef = useRef<AnalysisSurfaceHandle>(null);
  const sweepIdRef = useRef<bigint>(0n);
  const pointsByIndexRef = useRef<Map<number, SweepPointChartDatum>>(new Map());

  const cache = useMemo(
    () => new SweepSnapshotCache({ installer, cacheClient, loadEvaluationSnapshot }),
    [installer, cacheClient, loadEvaluationSnapshot],
  );

  const coordinator = useMemo(
    () =>
      new SweepCoordinator({
        createTransport: () => new WorkerBridge(),
        workerExecutablePath,
      }),
    [workerExecutablePath],
  );

  useEffect(() => {
    return () => coordinator.dispose();
  }, [coordinator]);

  useEffect(() => {
    return coordinator.onPointOutcome((outcome: SweepPointOutcome) => {
      const sweepId = sweepIdRef.current;
      setStatus((current) => {
        if (current.phase !== "running") return current;
        const completed = current.completed + 1;
        return { phase: completed >= current.total ? "done" : "running", completed, total: current.total };
      });
      if (outcome.kind !== "completed") return;
      void (async () => {
        const raw = await loadEvaluationSnapshot(outcome.result.snapshotPath);
        await cache.cachePoint(sweepId, outcome.result);
        const known = pointsByIndexRef.current.get(outcome.result.pointIndex);
        const datum: SweepPointChartDatum = {
          pointIndex: outcome.result.pointIndex,
          coordinates: known?.coordinates ?? [],
          observables: toObservableDatum(raw.observables),
        };
        pointsByIndexRef.current.set(outcome.result.pointIndex, datum);
        const sorted = [...pointsByIndexRef.current.values()].sort((a, b) => a.pointIndex - b.pointIndex);
        setPoints(sorted);
        analysisSurfaceRef.current?.renderSweepResult(sweepId, axesUsed, sorted);
      })().catch((error: unknown) => {
        // Was previously an unhandled rejection: any failure here (a bad
        // snapshot read, a cache error) silently dropped the point from
        // the chart with no visible signal beyond the point-count badge
        // still ticking up as if it had succeeded.
        setLastError(String(error));
      });
    });
    // axesUsed is read fresh via the ref-stable outer closure per sweep
    // start below (coordinates are seeded there before any outcome can
    // arrive), so this subscription doesn't need to be recreated per sweep.
  }, [coordinator, cache, loadEvaluationSnapshot, axesUsed]);

  const runSweep = useCallback(
    (axes: readonly SweepAxis[]) => {
      if (axes.length === 0) return;
      const sweepPoints = axes.length >= 2 ? gridSweepPoints(axes) : linearSweepPoints(axes[0]!);
      const parameterPaths = axes.map((axis) => axis.parameterPath);

      let baseline: Record<string, unknown> = baselineInputs;
      for (const [path, value] of Object.entries(pointValues)) {
        baseline = setDottedPath(baseline, path, value);
      }

      pointsByIndexRef.current = new Map(
        sweepPoints.map((point) => [point.index, { pointIndex: point.index, coordinates: point.coordinates, observables: [] }]),
      );
      sweepIdRef.current += 1n;
      setPoints([]);
      setSelectedPointIndex(null);
      setAxesUsed(parameterPaths);
      setStatus({ phase: "running", completed: 0, total: sweepPoints.length });
      cache.clear();
      analysisSurfaceRef.current?.clear();

      coordinator.start({
        projectRoot,
        templateId,
        templateVersion,
        baselineInputsJson: new TextEncoder().encode(JSON.stringify(baseline)),
        outputDirectory: `${outputDirectory}/sweep-${sweepIdRef.current}`,
        points: sweepPoints,
      });
    },
    [baselineInputs, pointValues, cache, coordinator, projectRoot, templateId, templateVersion, outputDirectory],
  );

  const cancelSweep = useCallback(() => coordinator.cancel(), [coordinator]);

  const onSurfaceEvent = useCallback(
    (event: AnalysisSurfaceEvent) => {
      if (event.kind === "pointSelected" && event.sweepId === sweepIdRef.current) {
        if (cache.selectPoint(event.sweepId, event.pointIndex)) {
          setSelectedPointIndex(event.pointIndex);
        }
      }
    },
    [cache],
  );

  return (
    <Stack gap="md" flex={1}>
      <Panel surface="panel" padding="md">
        <Text variant="heading">Hardware function laboratory</Text>
        <ControlPanel
          schema={inputSchema}
          values={pointValues}
          onChange={(path, value) => setPointValues((current) => ({ ...current, [path]: value }))}
        />
      </Panel>
      <Panel surface="panel" padding="md">
        <SweepDomainPanel
          schema={inputSchema}
          running={status.phase === "running"}
          onStart={runSweep}
          onCancel={cancelSweep}
        />
        {status.phase !== "idle" ? (
          <StatusBadge
            tone={status.phase === "running" ? "pending" : "success"}
            label={`${String(status.completed)}/${String(status.total)} points`}
          />
        ) : null}
        {lastError !== null ? (
          <Text variant="label" tone="secondary">
            Error rendering a point: {lastError}
          </Text>
        ) : null}
      </Panel>
      <Panel surface="display" padding="none" flex={1}>
        <AnalysisSurfaceView ref={analysisSurfaceRef} onSurfaceEvent={onSurfaceEvent} />
      </Panel>
      {selectedPointIndex !== null ? (
        <Text variant="label" tone="secondary">
          Viewing point {selectedPointIndex} ({String(points.length)} of {String(pointsByIndexRef.current.size)} points loaded)
        </Text>
      ) : null}
    </Stack>
  );
}
