import { describe, expect, it } from "vitest";
import {
  serializeAnalysisHostCommand,
  deserializeAnalysisHostCommand,
  serializeAnalysisSurfaceEvent,
  deserializeAnalysisSurfaceEvent,
} from "../../src/protocol/surfaces/analysis";

// Same precision probe used for the viewport/worker wire tests: proves the
// postMessage JSON boundary doesn't silently truncate a real sweep id.
const PRECISION_PROBE_SWEEP_ID = 9007199254740993n;

describe("AnalysisHostCommand wire (de)serialization", () => {
  it("round-trips sweepId losslessly through JSON for renderSweepResult", () => {
    const command = serializeAnalysisHostCommand({
      kind: "renderSweepResult",
      sweepId: PRECISION_PROBE_SWEEP_ID,
      parameterPaths: ["requirements.payload_kg"],
      points: [
        {
          pointIndex: 0,
          coordinates: [{ parameterPath: "requirements.payload_kg", value: 3 }],
          observables: [
            {
              observableId: "payload_margin",
              kind: "constraint_margin",
              label: "Payload margin",
              value: 47,
              unit: "kg",
              feasible: true,
            },
          ],
        },
      ],
    });
    expect(command).toContain(`"sweepId":"${PRECISION_PROBE_SWEEP_ID}"`);

    const decoded = deserializeAnalysisHostCommand(command);
    expect(decoded.kind).toBe("renderSweepResult");
    if (decoded.kind !== "renderSweepResult") throw new Error("unreachable");
    expect(decoded.sweepId).toBe(PRECISION_PROBE_SWEEP_ID);
    expect(typeof decoded.sweepId).toBe("bigint");
    expect(decoded.points[0]?.observables[0]?.observableId).toBe("payload_margin");
  });

  it("round-trips setSelectedPoint's sweepId and nullable pointIndex", () => {
    const command = serializeAnalysisHostCommand({
      kind: "setSelectedPoint",
      sweepId: PRECISION_PROBE_SWEEP_ID,
      pointIndex: null,
    });
    const decoded = deserializeAnalysisHostCommand(command);
    expect(decoded).toEqual({ kind: "setSelectedPoint", sweepId: PRECISION_PROBE_SWEEP_ID, pointIndex: null });
  });

  it("round-trips clear, which carries no sweepId", () => {
    const command = serializeAnalysisHostCommand({ kind: "clear" });
    expect(deserializeAnalysisHostCommand(command)).toEqual({ kind: "clear" });
  });
});

describe("AnalysisSurfaceEvent wire (de)serialization", () => {
  it("round-trips sweepId losslessly for pointSelected", () => {
    const event = serializeAnalysisSurfaceEvent({
      kind: "pointSelected",
      sweepId: PRECISION_PROBE_SWEEP_ID,
      pointIndex: 7,
    });
    const decoded = deserializeAnalysisSurfaceEvent(event);
    expect(decoded).toEqual({ kind: "pointSelected", sweepId: PRECISION_PROBE_SWEEP_ID, pointIndex: 7 });
  });

  it("round-trips ready, which carries no sweepId", () => {
    expect(deserializeAnalysisSurfaceEvent(serializeAnalysisSurfaceEvent({ kind: "ready" }))).toEqual({
      kind: "ready",
    });
  });
});
