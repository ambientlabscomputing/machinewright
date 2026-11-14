/**
 * The Export dialog: two tabs over one modal. (3D print layout has its own app-level tab.)
 *
 * - Assembly: whole-design STEP / STL (a copy of the files every evaluation
 *   already writes — instant).
 * - Parts: per-part (or combined) STL / STEP for all parts, printed parts
 *   only, or the current viewport selection. Runs as a worker job.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Overlay, Panel, Stack, StatusBadge, Text } from "../design-system/native";
import { exportAssemblyFile } from "../export/assemblyExport";
import type { ExportCoordinator, ExportJobHandle, ExportJobInput, ExportJobKind, ExportProgress } from "../export/ExportCoordinator";
import {
  DEFAULT_PART_SETTINGS,
  asPartExportResult,
  exportStem,
  partOptionsJson,
  type AssemblyFormat,
  type PartExportSettings,
} from "../export/exportModel";
import { loadExportSettings, saveExportSettings } from "../export/exportSettingsStore";
import { pickDirectory, revealInFinder } from "../native/FilePicker";

export type ExportTab = "assembly" | "parts";

export interface ExportDialogProps {
  readonly initialTab: ExportTab;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly outputDirectory: string;
  /** Graph digest of the accepted snapshot; `null` until the first evaluation completes. */
  readonly graphDigest: string | null;
  readonly selection: readonly string[];
  readonly coordinator: ExportCoordinator;
  /** Builds a worker request for the current inputs and unsaved source edits. */
  readonly buildJobInput: (kind: ExportJobKind, outputDirectory: string, options: unknown, basename: string) => ExportJobInput | null;
  readonly onClose: () => void;
}

type Status =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly label: string; readonly progress: ExportProgress | null }
  | { readonly kind: "done"; readonly message: string; readonly revealPath: string | null }
  | { readonly kind: "error"; readonly message: string };

const TABS: readonly { readonly id: ExportTab; readonly label: string }[] = [
  { id: "assembly", label: "Assembly" },
  { id: "parts", label: "Parts" },
];

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly id: T; readonly label: string; readonly disabled?: boolean }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <Field label={label}>
      <Stack direction="row" gap="xs" wrap>
        {options.map((option) => (
          <Button
            key={option.id}
            label={option.label}
            size="compact"
            tone={option.id === value ? "action" : "neutral"}
            disabled={option.disabled}
            onPress={() => onChange(option.id)}
          />
        ))}
      </Stack>
    </Field>
  );
}

export function ExportDialog(props: ExportDialogProps) {
  const { projectId, projectRoot, outputDirectory, graphDigest, selection, coordinator, buildJobInput, onClose } = props;
  const [tab, setTab] = useState<ExportTab>(props.initialTab);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [partSettings, setPartSettings] = useState<PartExportSettings>(DEFAULT_PART_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const jobRef = useRef<ExportJobHandle | null>(null);
  const mounted = useRef(true);
  const stem = exportStem(projectId);
  const running = status.kind === "running";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load persisted settings once; a missing/corrupt file just means defaults.
  useEffect(() => {
    loadExportSettings(projectRoot).then((saved) => {
      if (!mounted.current) return;
      setPartSettings(saved.parts);
      setLoaded(true);
    });
  }, [projectRoot]);

  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => void saveExportSettings(projectRoot, { parts: partSettings }).catch(() => {}), 400);
    return () => clearTimeout(timer);
  }, [loaded, projectRoot, partSettings]);

  const guard = useCallback(async (label: string, action: () => Promise<Status>) => {
    setStatus({ kind: "running", label, progress: null });
    try {
      const next = await action();
      if (mounted.current) setStatus(next);
    } catch (error) {
      if (mounted.current) setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const runJob = useCallback(
    async (kind: ExportJobKind, directory: string, options: unknown, label: string) => {
      const input = buildJobInput(kind, directory, options, stem);
      if (!input) throw new Error("The project is not ready to export yet.");
      const handle = coordinator.run(input, (progress) => {
        if (mounted.current) setStatus({ kind: "running", label, progress });
      });
      jobRef.current = handle;
      try {
        return await handle.outcome;
      } finally {
        jobRef.current = null;
      }
    },
    [buildJobInput, coordinator, stem],
  );

  const exportAssembly = (format: AssemblyFormat) =>
    guard(`Exporting ${format.toUpperCase()}…`, async () => {
      if (!graphDigest) throw new Error("Nothing to export yet — the design has not finished evaluating.");
      const result = await exportAssemblyFile({ outputDirectory, graphDigest, projectId, format });
      return result.kind === "saved"
        ? { kind: "done", message: `Saved ${result.path}`, revealPath: result.path }
        : { kind: "idle" };
    });

  const exportParts = () =>
    guard("Exporting parts…", async () => {
      const directory = await pickDirectory("Export", "Choose a folder for the exported part files");
      if (directory === null) return { kind: "idle" };
      const outcome = await runJob("parts", directory, partOptionsJson(partSettings, selection), "Exporting parts…");
      if (outcome.kind === "cancelled") return { kind: "idle" };
      if (outcome.kind === "failed") return { kind: "error", message: outcome.message };
      const count = asPartExportResult(outcome.result)?.files.length ?? 0;
      return { kind: "done", message: `Wrote ${count} ${count === 1 ? "file" : "files"} to ${directory}`, revealPath: directory };
    });

  const dismiss = () => {
    if (!running) onClose();
  };

  return (
    <Overlay onDismiss={dismiss}>
      <Panel surface="panel" padding="lg" elevated bordered>
        <Stack gap="md">
          <Stack direction="row" gap="md" align="center" justify="space-between">
            <Text variant="heading">Export</Text>
            <Button label="Close" size="compact" onPress={dismiss} disabled={running} />
          </Stack>
          <Stack direction="row" gap="xs">
            {TABS.map((item) => (
              <Button key={item.id} label={item.label} size="compact" tone={item.id === tab ? "action" : "neutral"} disabled={running} onPress={() => setTab(item.id)} />
            ))}
          </Stack>

          {tab === "assembly" ? (
            <Stack gap="sm">
              <Text tone="secondary">
                Export the whole design exactly as shown in the viewport. Parts keep their positions in the assembly.
              </Text>
              <Stack direction="row" gap="sm">
                <Button label="Export STEP…" tone="action" disabled={running || !graphDigest} onPress={() => void exportAssembly("step")} />
                <Button label="Export STL…" disabled={running || !graphDigest} onPress={() => void exportAssembly("stl")} />
              </Stack>
              <Text variant="label" tone="secondary">
                STEP keeps exact geometry for CAD and machining; STL is a triangle mesh for viewing and printing.
              </Text>
            </Stack>
          ) : null}

          {tab === "parts" ? (
            <Stack gap="md">
              <Choice
                label="Which parts"
                value={partSettings.scope}
                onChange={(scope) => setPartSettings({ ...partSettings, scope })}
                options={[
                  { id: "all", label: "All parts" },
                  { id: "printed", label: "Printed parts" },
                  { id: "selection", label: `Selection (${selection.length})`, disabled: selection.length === 0 },
                ]}
              />
              <Choice
                label="Format"
                value={partSettings.format}
                onChange={(format) => setPartSettings({ ...partSettings, format })}
                options={[
                  { id: "stl", label: "STL" },
                  { id: "step", label: "STEP" },
                ]}
              />
              <Choice
                label="Placement"
                value={partSettings.placement}
                onChange={(placement) => setPartSettings({ ...partSettings, placement })}
                options={[
                  { id: "assembly", label: "As assembled" },
                  { id: "origin", label: "Part origin" },
                ]}
              />
              <Choice
                label="Files"
                value={partSettings.combine ? "one" : "each"}
                onChange={(value) => setPartSettings({ ...partSettings, combine: value === "one" })}
                options={[
                  { id: "each", label: "One per part" },
                  { id: "one", label: "Single file" },
                ]}
              />
              <Stack direction="row">
                <Button label="Export Parts…" tone="action" disabled={running || (partSettings.scope === "selection" && selection.length === 0)} onPress={() => void exportParts()} />
              </Stack>
            </Stack>
          ) : null}

          {status.kind === "running" ? (
            <Stack direction="row" gap="sm" align="center">
              <StatusBadge tone="pending" label={status.progress ? status.progress.message : status.label} />
              {status.progress && status.progress.total > 1 ? (
                <Text variant="label" tone="secondary" numeric>
                  {Math.min(status.progress.completed + 1, status.progress.total)} / {status.progress.total}
                </Text>
              ) : null}
              {jobRef.current ? <Button label="Cancel" size="compact" onPress={() => jobRef.current?.cancel()} /> : null}
            </Stack>
          ) : null}
          {status.kind === "done" ? (
            <Stack direction="row" gap="sm" align="center" wrap>
              <StatusBadge tone="success" label={status.message} />
              {status.revealPath ? <Button label="Show in Finder" size="compact" onPress={() => void revealInFinder(status.revealPath ?? "")} /> : null}
            </Stack>
          ) : null}
          {status.kind === "error" ? <StatusBadge tone="error" label={status.message} /> : null}
        </Stack>
      </Panel>
    </Overlay>
  );
}
