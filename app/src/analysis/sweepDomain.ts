/**
 * TypeScript mirror of `linear_sweep_points`/`grid_sweep_points`
 * (src/machinewright/evaluation.py) — the UI builds the same point list the
 * Python sweep executor and CLI would build for identical axis inputs, so a
 * sweep run from the app matches the headlessly reproducible CLI reference
 * semantics (RFD-19 hard requirement #10) rather than inventing a second,
 * possibly-divergent point-generation scheme.
 */
import type { SweepPointInput } from "../evaluator/SweepCoordinator";

export interface SweepAxis {
  readonly parameterPath: string;
  readonly start: number;
  readonly stop: number;
  readonly points: number;
}

export function linearSweepPoints(axis: SweepAxis): SweepPointInput[] {
  if (axis.points < 2) throw new Error("points must be at least 2");
  return Array.from({ length: axis.points }, (_, index) => ({
    index,
    coordinates: [
      {
        parameterPath: axis.parameterPath,
        value: axis.start + ((axis.stop - axis.start) * index) / (axis.points - 1),
      },
    ],
  }));
}

/** The cartesian product of `axes`, row-major with the last axis varying fastest — matching `grid_sweep_points`'s point ordering exactly. */
export function gridSweepPoints(axes: readonly SweepAxis[]): SweepPointInput[] {
  if (axes.length < 1) throw new Error("at least one sweep axis is required");
  const axisValues = axes.map((axis) => {
    if (axis.points < 2) throw new Error("points must be at least 2");
    return Array.from({ length: axis.points }, (_, index) => ({
      parameterPath: axis.parameterPath,
      value: axis.start + ((axis.stop - axis.start) * index) / (axis.points - 1),
    }));
  });

  let combinations: Array<Array<{ parameterPath: string; value: number }>> = [[]];
  for (const values of axisValues) {
    combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, value]));
  }
  return combinations.map((coordinates, index) => ({ index, coordinates }));
}
