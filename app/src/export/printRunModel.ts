/**
 * State of one print-plate generation, built up from the worker's export
 * progress events (see `export_print_plan`'s docstring for the stage protocol):
 * "orient" per part, "pack", "layout" (the whole plan, no files yet), "plate"
 * before each write, and "plate_ready" (that plate, file on disk) after it.
 * Pure and UI-free so the progress arithmetic and plate availability are unit-testable.
 */
import { defaultJoinPath } from "../workspace/Project";
import type { ExportProgress } from "./ExportCoordinator";
import type { PlanPlate, PrintPlan } from "./exportModel";

export interface PrintRunState {
  readonly phase: "idle" | "running" | "done" | "failed" | "cancelled";
  /** Plain-language description of what the worker is doing right now. */
  readonly label: string;
  /** 0–1, or `null` while the length of the work is not yet known (design evaluation). */
  readonly fraction: number | null;
  readonly plan: PrintPlan | null;
  /** Plates whose STL is written, by plate index → file name inside the work directory. */
  readonly files: Readonly<Record<number, string>>;
  readonly error: string | null;
  /** Bumped on every new run so viewers never confuse files from an earlier run with this one's. */
  readonly runId: number;
}

export const IDLE_PRINT_RUN: PrintRunState = {
  phase: "idle",
  label: "",
  fraction: null,
  plan: null,
  files: {},
  error: null,
  runId: 0,
};

export function startPrintRun(previous: PrintRunState): PrintRunState {
  return { ...IDLE_PRINT_RUN, phase: "running", label: "Evaluating design…", runId: previous.runId + 1 };
}

// The bar spans orienting parts (first half) and writing plates (second half).
const ORIENT_SHARE = 0.4;
const PACK_SHARE = 0.1;

function parsePlan(message: string): PrintPlan | null {
  try {
    const value = JSON.parse(message) as PrintPlan;
    return Array.isArray(value.plates) ? value : null;
  } catch {
    return null;
  }
}

function parsePlate(message: string): PlanPlate | null {
  try {
    const value = JSON.parse(message) as PlanPlate;
    return typeof value.index === "number" && typeof value.stl_file === "string" ? value : null;
  } catch {
    return null;
  }
}

export function applyPrintProgress(state: PrintRunState, progress: ExportProgress): PrintRunState {
  if (state.phase !== "running") return state;
  const total = Math.max(progress.total, 1);
  switch (progress.stage) {
    case "orient":
      return { ...state, label: progress.message, fraction: (progress.completed / total) * ORIENT_SHARE };
    case "pack":
      return { ...state, label: "Packing plates…", fraction: ORIENT_SHARE };
    case "layout": {
      const plan = parsePlan(progress.message);
      return {
        ...state,
        plan: plan ?? state.plan,
        label: plan ? `Laid out ${plan.plates.length} ${plan.plates.length === 1 ? "plate" : "plates"} — writing meshes…` : state.label,
        fraction: ORIENT_SHARE + PACK_SHARE,
      };
    }
    case "plate":
      return { ...state, label: progress.message, fraction: ORIENT_SHARE + PACK_SHARE + (progress.completed / total) * (1 - ORIENT_SHARE - PACK_SHARE) };
    case "plate_ready": {
      const plate = parsePlate(progress.message);
      return {
        ...state,
        files: plate ? { ...state.files, [plate.index]: plate.stl_file ?? "" } : state.files,
        fraction: ORIENT_SHARE + PACK_SHARE + (progress.completed / total) * (1 - ORIENT_SHARE - PACK_SHARE),
      };
    }
    default:
      return { ...state, label: progress.message || state.label };
  }
}

/** The final plan replaces the streamed one; files come from it so a run that skipped events still ends consistent. */
export function finishPrintRun(state: PrintRunState, plan: PrintPlan): PrintRunState {
  const files: Record<number, string> = {};
  for (const plate of plan.plates) if (plate.stl_file) files[plate.index] = plate.stl_file;
  return { ...state, phase: "done", label: "", fraction: 1, plan, files, error: null };
}

export function failPrintRun(state: PrintRunState, message: string): PrintRunState {
  return { ...state, phase: "failed", label: "", error: message };
}

export function cancelPrintRun(state: PrintRunState): PrintRunState {
  return { ...state, phase: "cancelled", label: "" };
}

/** Where a run's plates and plan JSON are written (private working copy, exported on demand). */
export function printWorkDirectory(projectRoot: string): string {
  return defaultJoinPath(projectRoot, ".machinewright", "print");
}

export const PRINT_BASENAME = "print";

export function plateFilePath(workDirectory: string, fileName: string): string {
  return defaultJoinPath(workDirectory, fileName);
}

/** Files to copy out when exporting: every written plate plus the plan JSON, once the run is done. */
export function exportableFiles(state: PrintRunState): readonly string[] {
  if (state.phase !== "done" || !state.plan) return [];
  const names = Object.values(state.files);
  return names.length === 0 ? [] : [...names, `${PRINT_BASENAME}-plan.json`];
}

/** `file://` URL for a local path (each segment percent-encoded), as the WebView's XHR needs. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}
