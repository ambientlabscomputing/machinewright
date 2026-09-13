import { describe, expect, it } from "vitest";
import { gridSweepPoints, linearSweepPoints } from "../../src/analysis/sweepDomain";

describe("linearSweepPoints", () => {
  it("matches the Python reference CLI's 3..63 step-3 sweep exactly", () => {
    const points = linearSweepPoints({
      parameterPath: "requirements.payload_kg",
      start: 3,
      stop: 63,
      points: 21,
    });
    expect(points).toHaveLength(21);
    expect(points[0]).toEqual({ index: 0, coordinates: [{ parameterPath: "requirements.payload_kg", value: 3 }] });
    expect(points[20]?.coordinates[0]?.value).toBe(63);
    expect(points.map((p) => p.coordinates[0]?.value)).toEqual(
      Array.from({ length: 21 }, (_, i) => 3 + i * 3),
    );
  });

  it("rejects fewer than 2 points", () => {
    expect(() => linearSweepPoints({ parameterPath: "x", start: 0, stop: 1, points: 1 })).toThrow();
  });
});

describe("gridSweepPoints", () => {
  it("is the row-major cartesian product with the last axis varying fastest", () => {
    const points = gridSweepPoints([
      { parameterPath: "a", start: 0, stop: 1, points: 2 },
      { parameterPath: "b", start: 10, stop: 20, points: 3 },
    ]);
    expect(points).toHaveLength(6);
    expect(points.map((p) => p.coordinates[1]?.value)).toEqual([10, 15, 20, 10, 15, 20]);
    expect(points.map((p) => p.coordinates[0]?.value)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(points.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("rejects an empty axis list", () => {
    expect(() => gridSweepPoints([])).toThrow();
  });
});
