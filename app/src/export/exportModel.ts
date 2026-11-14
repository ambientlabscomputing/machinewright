/**
 * Pure model for the Export dialog: option shapes (mirroring the Python
 * `PartExportOptions` / `PrintPlanOptions` JSON documents), defaults, the
 * persisted printer settings, and the helpers that turn them into worker
 * requests. No React, no native modules — unit-testable on its own.
 */

import { traverseDepthFirst, type GraphIndex } from "../graph/GraphIndex";

// --- Assembly artifacts (already written by every evaluation) -----------------

export type AssemblyFormat = "step" | "stl";

/**
 * Every evaluation writes `assembly-<first 12 hex of graph digest>.<ext>` into
 * the project's output directory (see `export_service.export_artifacts`), so a
 * whole-assembly export is a copy of that file, not a re-evaluation.
 */
export function assemblyArtifactName(graphDigest: string, format: AssemblyFormat): string {
  const hex = graphDigest.split(":")[1] ?? graphDigest;
  return `assembly-${hex.slice(0, 12)}.${format}`;
}

/** `ironless-actuator.main` → `ironless-actuator-main`; safe as a file name stem. */
export function exportStem(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "assembly";
}

// --- Parts export -----------------------------------------------------------------

export type PartScope = "all" | "printed" | "selection";
export type PartFormat = "stl" | "step";
export type PartPlacement = "assembly" | "origin";

export interface PartExportSettings {
  readonly scope: PartScope;
  readonly format: PartFormat;
  readonly placement: PartPlacement;
  readonly combine: boolean;
}

export const DEFAULT_PART_SETTINGS: PartExportSettings = {
  scope: "all",
  format: "stl",
  placement: "assembly",
  combine: false,
};

/** The Python `PartExportOptions` document. `selection` must be the selected graph node ids. */
export function partOptionsJson(settings: PartExportSettings, selection: readonly string[]): Record<string, unknown> {
  return {
    format: settings.format,
    placement: settings.placement,
    combine: settings.combine,
    node_ids: settings.scope === "selection" ? [...selection] : null,
    processes: settings.scope === "printed" ? ["PRINTED"] : null,
  };
}

/**
 * Part node ids covered by a selection: selected parts themselves, plus every
 * part beneath a selected assembly. Order follows the graph; each id appears once.
 */
export function selectedPartIds(index: GraphIndex, selection: readonly string[]): readonly string[] {
  const covered = new Set<string>();
  for (const id of selection) {
    if (!index.byId.has(id)) continue;
    for (const descendant of traverseDepthFirst(index, id)) covered.add(descendant);
  }
  return traverseDepthFirst(index).filter((id) => covered.has(id) && index.byId.get(id)?.kind === "part");
}

// --- Print layout ------------------------------------------------------------------

export interface PrinterSettings {
  readonly name: string;
  readonly bedX: number;
  readonly bedY: number;
  readonly maxZ: number;
  readonly bedMargin: number;
  readonly origin: "corner" | "center";
}

export interface PlanSettings {
  readonly partSpacing: number;
  readonly optimizeOrientation: boolean;
}

export interface PrintSettings {
  readonly printer: PrinterSettings;
  readonly plan: PlanSettings;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  printer: { name: "My printer", bedX: 220, bedY: 220, maxZ: 250, bedMargin: 5, origin: "corner" },
  plan: { partSpacing: 6, optimizeOrientation: true },
};

/** A part's footprint lower-left corner, mm from the bed's front-left corner (as in `PlanPart`). */
export interface PartPosition {
  readonly x: number;
  readonly y: number;
}

/** The Python `PrintPlanOptions` document. `positions` are hand-moved parts, keyed by node id. */
export function printOptionsJson(
  settings: PrintSettings,
  write: boolean,
  live = false,
  positions: Readonly<Record<string, PartPosition>> = {},
): Record<string, unknown> {
  return {
    write,
    live,
    positions: Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, [p.x, p.y]])),
    printer: {
      name: settings.printer.name,
      bed_x: settings.printer.bedX,
      bed_y: settings.printer.bedY,
      max_z: settings.printer.maxZ,
      bed_margin: settings.printer.bedMargin,
      origin: settings.printer.origin,
    },
    settings: {
      part_spacing: settings.plan.partSpacing,
      optimize_orientation: settings.plan.optimizeOrientation,
    },
  };
}

export interface PlanPart {
  readonly node_id: string;
  readonly instance_key: string;
  readonly definition_id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly rotated: boolean;
  readonly orientation: number;
}

export interface PlanPlate {
  readonly index: number;
  readonly material: string;
  readonly max_height: number;
  readonly parts: readonly PlanPart[];
  readonly stl_file: string | null;
}

export interface PrintPlan {
  readonly printer: string;
  readonly bed_x: number;
  readonly bed_y: number;
  readonly max_z: number;
  readonly origin: string;
  readonly plates: readonly PlanPlate[];
  readonly skipped: readonly { readonly node_id: string; readonly instance_key: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export interface PartExportResult {
  readonly files: readonly { readonly name: string; readonly node_ids: readonly string[]; readonly byte_size: number }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow a worker result to a print plan, or `null` if it is not one. */
export function asPrintPlan(value: unknown): PrintPlan | null {
  if (!isRecord(value) || !Array.isArray(value.plates) || !Array.isArray(value.skipped)) return null;
  return value as unknown as PrintPlan;
}

export function asPartExportResult(value: unknown): PartExportResult | null {
  if (!isRecord(value) || !Array.isArray(value.files)) return null;
  return value as unknown as PartExportResult;
}

/** Human summary of a plan, e.g. "5 plates · 20 parts · 1 skipped". */
export function summarizePlan(plan: PrintPlan): string {
  const parts = plan.plates.reduce((total, plate) => total + plate.parts.length, 0);
  const pieces = [`${plan.plates.length} ${plan.plates.length === 1 ? "plate" : "plates"}`, `${parts} ${parts === 1 ? "part" : "parts"}`];
  if (plan.skipped.length > 0) pieces.push(`${plan.skipped.length} skipped`);
  return pieces.join(" · ");
}

// --- Persistence -------------------------------------------------------------------

const SETTINGS_FILE = ".machinewright/export-settings.json";

export function exportSettingsPath(projectRoot: string): string {
  return `${projectRoot.replace(/\/+$/, "")}/${SETTINGS_FILE}`;
}

export interface PersistedExportSettings {
  readonly parts: PartExportSettings;
  readonly print: PrintSettings;
}

function finite(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * Tolerant parse of the settings file: anything missing or malformed falls back
 * to the default for that field, so a hand-edited or older file never blocks the dialog.
 */
export function parseExportSettings(text: string): PersistedExportSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const root = isRecord(raw) ? raw : {};
  const parts = isRecord(root.parts) ? root.parts : {};
  const print = isRecord(root.print) ? root.print : {};
  const printer = isRecord(print.printer) ? print.printer : {};
  const plan = isRecord(print.plan) ? print.plan : {};
  const d = DEFAULT_PRINT_SETTINGS;
  return {
    parts: {
      scope: (["all", "printed", "selection"] as const).find((v) => v === parts.scope) ?? DEFAULT_PART_SETTINGS.scope,
      format: (["stl", "step"] as const).find((v) => v === parts.format) ?? DEFAULT_PART_SETTINGS.format,
      placement: (["assembly", "origin"] as const).find((v) => v === parts.placement) ?? DEFAULT_PART_SETTINGS.placement,
      combine: typeof parts.combine === "boolean" ? parts.combine : DEFAULT_PART_SETTINGS.combine,
    },
    print: {
      printer: {
        name: typeof printer.name === "string" && printer.name.trim() ? printer.name : d.printer.name,
        bedX: finite(printer.bedX, d.printer.bedX, 1),
        bedY: finite(printer.bedY, d.printer.bedY, 1),
        maxZ: finite(printer.maxZ, d.printer.maxZ, 1),
        bedMargin: finite(printer.bedMargin, d.printer.bedMargin, 0),
        origin: printer.origin === "center" ? "center" : "corner",
      },
      plan: {
        partSpacing: finite(plan.partSpacing, d.plan.partSpacing, 0),
        optimizeOrientation: typeof plan.optimizeOrientation === "boolean" ? plan.optimizeOrientation : d.plan.optimizeOrientation,
      },
    },
  };
}
