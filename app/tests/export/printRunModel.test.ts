import { describe, expect, it } from "vitest";
import {
  IDLE_PRINT_RUN,
  applyPrintProgress,
  cancelPrintRun,
  exportableFiles,
  failPrintRun,
  finishPrintRun,
  startPrintRun,
} from "../../src/export/printRunModel";
import type { PrintPlan } from "../../src/export/exportModel";

const plate = (index: number, file: string | null) => ({ index, material: "PLA", max_height: 5, parts: [], stl_file: file });
const plan = (files: (string | null)[]): PrintPlan => ({
  printer: "p",
  bed_x: 220,
  bed_y: 220,
  max_z: 250,
  origin: "corner",
  plates: files.map((file, i) => plate(i + 1, file)),
  skipped: [],
  warnings: [],
});
const event = (stage: string, completed: number, total: number, message = "") => ({ stage, completed, total, message });

describe("print run progress", () => {
  it("starts indeterminate while the design evaluates", () => {
    const state = startPrintRun(IDLE_PRINT_RUN);
    expect(state.phase).toBe("running");
    expect(state.fraction).toBeNull();
    expect(state.runId).toBe(1);
  });

  it("advances monotonically through orient, pack, and plate writes", () => {
    let state = startPrintRun(IDLE_PRINT_RUN);
    const seen: number[] = [];
    const feed = (e: ReturnType<typeof event>) => {
      state = applyPrintProgress(state, e);
      seen.push(state.fraction ?? -1);
    };
    feed(event("orient", 0, 4, "Orienting a"));
    feed(event("orient", 3, 4, "Orienting d"));
    feed(event("pack", 4, 4));
    feed(event("layout", 0, 2, JSON.stringify(plan([null, null]))));
    feed(event("plate", 0, 2, "Writing plate 1"));
    feed(event("plate_ready", 1, 2, JSON.stringify(plate(1, "print-plate-01-pla.stl"))));
    feed(event("plate", 1, 2, "Writing plate 2"));
    feed(event("plate_ready", 2, 2, JSON.stringify(plate(2, "print-plate-02-pla.stl"))));
    expect(seen.every((value, i) => i === 0 || value >= seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)).toBeCloseTo(1);
    expect(state.plan?.plates).toHaveLength(2);
    expect(state.files).toEqual({ 1: "print-plate-01-pla.stl", 2: "print-plate-02-pla.stl" });
  });

  it("ignores events after the run ended and tolerates malformed payloads", () => {
    const running = applyPrintProgress(startPrintRun(IDLE_PRINT_RUN), event("layout", 0, 1, "not json"));
    expect(running.plan).toBeNull();
    expect(applyPrintProgress(running, event("plate_ready", 1, 1, "{}")).files).toEqual({});
    const cancelled = cancelPrintRun(running);
    expect(applyPrintProgress(cancelled, event("orient", 1, 2)).phase).toBe("cancelled");
  });

  it("finishes with the final plan's files and lists them for export", () => {
    const done = finishPrintRun(startPrintRun(IDLE_PRINT_RUN), plan(["a.stl", "b.stl"]));
    expect(done.phase).toBe("done");
    expect(exportableFiles(done)).toEqual(["a.stl", "b.stl", "print-plan.json"]);
    expect(exportableFiles(failPrintRun(done, "boom"))).toEqual([]);
    expect(exportableFiles(finishPrintRun(startPrintRun(IDLE_PRINT_RUN), plan([])))).toEqual([]);
  });
});
