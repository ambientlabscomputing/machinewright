/**
 * Versioned messages between the RN/TS application shell and the bundled
 * WebView surface hosting sweep/behavior charts (RFD-19 M3, "Behavior
 * laboratory" — feasible regions, sensitivity, candidate changes, and
 * "selecting a point in a plot loads the corresponding graph and geometry
 * snapshot").
 *
 * Mirrors viewport.ts's shape deliberately: `renderSweepResult` stages a
 * sweep's points for display, `pointSelected` reports a click back to the
 * host, which then drives `SweepSnapshotCache.selectPoint()` — this surface
 * never touches `SnapshotStore` or the viewport itself. `sweepId` is a wire
 * uint64 like `Generation`, so it reuses the same bigint<->string wire
 * conversion rather than a second copy of it.
 */
import { type Generation, generationToWire, generationFromWire } from "./version";

export interface SweepPointCoordinateDatum {
  readonly parameterPath: string;
  readonly value: number;
}

export interface SweepPointObservableDatum {
  readonly observableId: string;
  readonly kind: string;
  readonly label: string;
  readonly value: unknown;
  readonly unit: string | null;
  readonly feasible: boolean | null;
}

export interface SweepPointChartDatum {
  readonly pointIndex: number;
  readonly coordinates: readonly SweepPointCoordinateDatum[];
  readonly observables: readonly SweepPointObservableDatum[];
}

/** Commands the application shell sends into the analysis WebView. */
export type AnalysisHostCommand =
  | {
      readonly kind: "renderSweepResult";
      readonly sweepId: Generation;
      readonly parameterPaths: readonly string[]; // one axis for a 1D sweep, two for a 2D grid
      readonly points: readonly SweepPointChartDatum[];
    }
  | { readonly kind: "setSelectedPoint"; readonly sweepId: Generation; readonly pointIndex: number | null }
  | { readonly kind: "clear" };

/** Events the analysis WebView emits back to the application shell. */
export type AnalysisSurfaceEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "pointSelected"; readonly sweepId: Generation; readonly pointIndex: number };

function hostCommandHasSweepId(
  command: AnalysisHostCommand,
): command is Exclude<AnalysisHostCommand, { kind: "clear" }> {
  return command.kind !== "clear";
}

function surfaceEventHasSweepId(
  event: AnalysisSurfaceEvent,
): event is Exclude<AnalysisSurfaceEvent, { kind: "ready" }> {
  return event.kind !== "ready";
}

export function serializeAnalysisHostCommand(command: AnalysisHostCommand): string {
  if (!hostCommandHasSweepId(command)) return JSON.stringify(command);
  return JSON.stringify({ ...command, sweepId: generationToWire(command.sweepId) });
}

export function deserializeAnalysisHostCommand(json: string): AnalysisHostCommand {
  const parsed = JSON.parse(json) as AnalysisHostCommand;
  if (!hostCommandHasSweepId(parsed)) return parsed;
  return { ...parsed, sweepId: generationFromWire(parsed.sweepId as unknown as string) };
}

export function serializeAnalysisSurfaceEvent(event: AnalysisSurfaceEvent): string {
  if (!surfaceEventHasSweepId(event)) return JSON.stringify(event);
  return JSON.stringify({ ...event, sweepId: generationToWire(event.sweepId) });
}

export function deserializeAnalysisSurfaceEvent(json: string): AnalysisSurfaceEvent {
  const parsed = JSON.parse(json) as AnalysisSurfaceEvent;
  if (!surfaceEventHasSweepId(parsed)) return parsed;
  return { ...parsed, sweepId: generationFromWire(parsed.sweepId as unknown as string) };
}
