/**
 * Pure derivation of RFD-19 M3's "feasible operating regions, constraint
 * boundaries, sensitivity and uncertainty, discontinuities and candidate
 * transitions" from a completed sweep's per-point observables. No new
 * Python numerics are needed for a first cut: `ObservableKind` already
 * distinguishes `constraint_margin` and `candidate` observables
 * (src/machinewright/templates.py), so this module only reshapes data that
 * already flows through `SweepCoordinator`'s completed-point results —
 * everything here operates on `SweepPointChartDatum[]`
 * (protocol/surfaces/analysis.ts), the same shape the analysis WebView
 * surface renders.
 *
 * `Observable.value` is canonical-JSON-encoded on the wire (see
 * machinewright/canonical.py): floats round-trip as decimal *strings*, not
 * JSON numbers, so every numeric read here goes through `numericValue`
 * rather than assuming `typeof value === "number"`.
 */
import type { SweepPointChartDatum, SweepPointObservableDatum } from "../protocol/surfaces/analysis";

export function numericValue(observable: SweepPointObservableDatum): number | null {
  if (typeof observable.value === "number") {
    return Number.isFinite(observable.value) ? observable.value : null;
  }
  if (typeof observable.value === "string") {
    const parsed = Number(observable.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findObservable(
  point: SweepPointChartDatum,
  observableId: string,
): SweepPointObservableDatum | undefined {
  return point.observables.find((observable) => observable.observableId === observableId);
}

function numericObservableValue(point: SweepPointChartDatum, observableId: string): number | null {
  const observable = findObservable(point, observableId);
  return observable === undefined ? null : numericValue(observable);
}

export interface FeasibilitySegment {
  readonly feasible: boolean;
  readonly fromPointIndex: number;
  readonly toPointIndex: number;
}

/** Contiguous runs of the same `feasible` value for `observableId`, in point order — the shading RFD-19 calls "feasible operating regions." Points where the observable is missing or has no `feasible` flag break a run rather than joining across it. */
export function feasibilitySegments(
  points: readonly SweepPointChartDatum[],
  observableId: string,
): FeasibilitySegment[] {
  const segments: FeasibilitySegment[] = [];
  let current: { feasible: boolean; fromPointIndex: number; toPointIndex: number } | null = null;
  for (const point of points) {
    const feasible = findObservable(point, observableId)?.feasible;
    if (feasible === null || feasible === undefined) {
      current = null;
      continue;
    }
    if (current !== null && current.feasible === feasible) {
      current.toPointIndex = point.pointIndex;
    } else {
      current = { feasible, fromPointIndex: point.pointIndex, toPointIndex: point.pointIndex };
      segments.push(current);
    }
  }
  return segments;
}

export interface FeasibilityFlip {
  readonly fromPointIndex: number;
  readonly toPointIndex: number;
  readonly fromFeasible: boolean;
  readonly toFeasible: boolean;
}

/** The constraint-boundary crossings between adjacent points — where `feasibilitySegments` changes value. */
export function feasibilityFlips(
  points: readonly SweepPointChartDatum[],
  observableId: string,
): FeasibilityFlip[] {
  const flips: FeasibilityFlip[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const previousFeasible = findObservable(previous, observableId)?.feasible;
    const currentFeasible = findObservable(current, observableId)?.feasible;
    if (previousFeasible === null || previousFeasible === undefined) continue;
    if (currentFeasible === null || currentFeasible === undefined) continue;
    if (previousFeasible !== currentFeasible) {
      flips.push({
        fromPointIndex: previous.pointIndex,
        toPointIndex: current.pointIndex,
        fromFeasible: previousFeasible,
        toFeasible: currentFeasible,
      });
    }
  }
  return flips;
}

export interface SensitivitySample {
  readonly fromPointIndex: number;
  readonly toPointIndex: number;
  /** Finite-difference d(observable)/d(axis) between these two adjacent points. */
  readonly slope: number;
}

/** Finite-difference sensitivity of `observableId` with respect to `axisParameterPath` between adjacent points. Meaningful for a 1D sweep, or one axis of a 2D grid where points are pointwise-adjacent along it; a pair with a non-numeric axis or observable value, or a zero axis step, is skipped rather than producing `Infinity`/`NaN`. */
export function sensitivitySlopes(
  points: readonly SweepPointChartDatum[],
  axisParameterPath: string,
  observableId: string,
): SensitivitySample[] {
  const samples: SensitivitySample[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const previousAxis = previous.coordinates.find((c) => c.parameterPath === axisParameterPath)?.value;
    const currentAxis = current.coordinates.find((c) => c.parameterPath === axisParameterPath)?.value;
    const previousValue = numericObservableValue(previous, observableId);
    const currentValue = numericObservableValue(current, observableId);
    if (previousAxis === undefined || currentAxis === undefined) continue;
    if (previousValue === null || currentValue === null) continue;
    const axisDelta = currentAxis - previousAxis;
    if (axisDelta === 0) continue;
    samples.push({
      fromPointIndex: previous.pointIndex,
      toPointIndex: current.pointIndex,
      slope: (currentValue - previousValue) / axisDelta,
    });
  }
  return samples;
}

export interface CandidateChange {
  readonly fromPointIndex: number;
  readonly toPointIndex: number;
  readonly observableId: string;
  readonly label: string;
  readonly fromValue: unknown;
  readonly toValue: unknown;
}

/** `candidate`-kind observables whose value differs between adjacent points — RFD-19's "candidate transitions." */
export function candidateChanges(points: readonly SweepPointChartDatum[]): CandidateChange[] {
  const changes: CandidateChange[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    for (const observable of current.observables) {
      if (observable.kind !== "candidate") continue;
      const previousObservable = findObservable(previous, observable.observableId);
      if (previousObservable === undefined) continue;
      if (JSON.stringify(previousObservable.value) === JSON.stringify(observable.value)) continue;
      changes.push({
        fromPointIndex: previous.pointIndex,
        toPointIndex: current.pointIndex,
        observableId: observable.observableId,
        label: observable.label,
        fromValue: previousObservable.value,
        toValue: observable.value,
      });
    }
  }
  return changes;
}

export interface Discontinuity {
  readonly fromPointIndex: number;
  readonly toPointIndex: number;
  readonly delta: number;
}

/** Heuristic, not a numerical discontinuity detector: flags adjacent-point deltas in `observableId` exceeding `thresholdFraction` of that observable's overall range across `points`. */
export function discontinuities(
  points: readonly SweepPointChartDatum[],
  observableId: string,
  thresholdFraction = 0.25,
): Discontinuity[] {
  const values = points
    .map((point) => numericObservableValue(point, observableId))
    .filter((value): value is number => value !== null);
  if (values.length < 2) return [];
  const range = Math.max(...values) - Math.min(...values);
  if (range === 0) return [];
  const threshold = range * thresholdFraction;
  const results: Discontinuity[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previousValue = numericObservableValue(points[index - 1]!, observableId);
    const currentValue = numericObservableValue(points[index]!, observableId);
    if (previousValue === null || currentValue === null) continue;
    const delta = Math.abs(currentValue - previousValue);
    if (delta > threshold) {
      results.push({
        fromPointIndex: points[index - 1]!.pointIndex,
        toPointIndex: points[index]!.pointIndex,
        delta,
      });
    }
  }
  return results;
}
