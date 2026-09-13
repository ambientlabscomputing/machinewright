/**
 * Fixture mirrors the reference template's real sweep semantics (see
 * tests/test_m3_behavior_lab.py on the Python side): `payload_margin =
 * 50 - payload_kg`, feasible while `payload_margin >= 0`. Values are given
 * as decimal strings for the numeric observable to match how canonical JSON
 * actually encodes floats on the wire (machinewright/canonical.py) — the
 * whole point of `numericValue` is coercing exactly this shape.
 */
import { describe, expect, it } from "vitest";
import type { SweepPointChartDatum } from "../../src/protocol/surfaces/analysis";
import {
  candidateChanges,
  discontinuities,
  feasibilityFlips,
  feasibilitySegments,
  numericValue,
  sensitivitySlopes,
} from "../../src/analysis/sensitivity";

function payloadSweepPoints(payloadValues: readonly number[]): SweepPointChartDatum[] {
  return payloadValues.map((payload, index) => {
    const margin = 50 - payload;
    return {
      pointIndex: index,
      coordinates: [{ parameterPath: "requirements.payload_kg", value: payload }],
      observables: [
        {
          observableId: "payload_margin",
          kind: "constraint_margin",
          label: "Payload margin",
          value: String(margin),
          unit: "kg",
          feasible: margin >= 0,
        },
      ],
    };
  });
}

describe("numericValue", () => {
  it("parses a canonical-JSON decimal string", () => {
    expect(
      numericValue({
        observableId: "x",
        kind: "scalar",
        label: "x",
        value: "28",
        unit: null,
        feasible: null,
      }),
    ).toBe(28);
  });

  it("returns null for a non-numeric value (e.g. a candidate label)", () => {
    expect(
      numericValue({
        observableId: "x",
        kind: "candidate",
        label: "x",
        value: "motor-A",
        unit: null,
        feasible: null,
      }),
    ).toBeNull();
  });
});

describe("feasibilitySegments / feasibilityFlips", () => {
  it("finds exactly one flip crossing payload_kg=50 in a 3..63 step-3 sweep (matches the pinned CLI test)", () => {
    const payloads = Array.from({ length: 21 }, (_, i) => 3 + i * 3); // 3,6,...,63
    const points = payloadSweepPoints(payloads);

    const segments = feasibilitySegments(points, "payload_margin");
    expect(segments.filter((s) => s.feasible)).toHaveLength(1);
    expect(segments.filter((s) => !s.feasible)).toHaveLength(1);

    const flips = feasibilityFlips(points, "payload_margin");
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ fromFeasible: true, toFeasible: false });
  });

  it("returns no flips for an observable that never crosses its boundary", () => {
    const points = payloadSweepPoints([3, 6, 9, 12]); // margin stays positive throughout
    expect(feasibilityFlips(points, "payload_margin")).toEqual([]);
  });
});

describe("sensitivitySlopes", () => {
  it("computes a constant slope of -1 for payload_margin = 50 - payload_kg", () => {
    const points = payloadSweepPoints([10, 20, 30]);
    const slopes = sensitivitySlopes(points, "requirements.payload_kg", "payload_margin");
    expect(slopes).toHaveLength(2);
    for (const sample of slopes) expect(sample.slope).toBeCloseTo(-1);
  });

  it("skips a pair with a zero axis step instead of producing Infinity", () => {
    const points = payloadSweepPoints([10, 10]);
    expect(sensitivitySlopes(points, "requirements.payload_kg", "payload_margin")).toEqual([]);
  });
});

describe("discontinuities", () => {
  it("flags a jump much larger than the sweep's typical step", () => {
    const points: SweepPointChartDatum[] = [0, 1, 2, 50, 51].map((value, index) => ({
      pointIndex: index,
      coordinates: [{ parameterPath: "x", value: index }],
      observables: [
        { observableId: "y", kind: "scalar", label: "y", value: String(value), unit: null, feasible: null },
      ],
    }));
    const flagged = discontinuities(points, "y", 0.5);
    expect(flagged.map((d) => [d.fromPointIndex, d.toPointIndex])).toContainEqual([2, 3]);
  });

  it("returns nothing for a flat observable (zero range)", () => {
    const points = payloadSweepPoints([10]).concat(payloadSweepPoints([10]).map((p) => ({ ...p, pointIndex: 1 })));
    expect(discontinuities(points, "payload_margin")).toEqual([]);
  });
});

describe("candidateChanges", () => {
  it("reports a candidate observable's value changing between adjacent points", () => {
    const points: SweepPointChartDatum[] = [
      { pointIndex: 0, coordinates: [], observables: [{ observableId: "motor", kind: "candidate", label: "Motor", value: "A", unit: null, feasible: null }] },
      { pointIndex: 1, coordinates: [], observables: [{ observableId: "motor", kind: "candidate", label: "Motor", value: "A", unit: null, feasible: null }] },
      { pointIndex: 2, coordinates: [], observables: [{ observableId: "motor", kind: "candidate", label: "Motor", value: "B", unit: null, feasible: null }] },
    ];
    const changes = candidateChanges(points);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromPointIndex: 1, toPointIndex: 2, fromValue: "A", toValue: "B" });
  });
});
