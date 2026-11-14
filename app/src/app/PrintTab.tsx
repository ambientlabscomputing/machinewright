/**
 * The 3D Print workspace: one full-bleed 3D view of the generated plates with
 * floating tool boxes over it — printer settings and Generate on the left, the
 * plate list/details and export on the right, and a progress card while plates
 * are being generated. Plates appear in the view as soon as each one is written.
 *
 * Nothing here slices: the output is one STL per plate for a real slicer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, Field, NumericInput, Panel, Stack, StatusBadge, Text, TextField } from "../design-system/native";
import { colors } from "../design-system/tokens/colors";
import { radius } from "../design-system/tokens/shape";
import type { ExportCoordinator, ExportJobHandle, ExportJobInput, ExportJobKind } from "../export/ExportCoordinator";
import { DEFAULT_PRINT_SETTINGS, asPrintPlan, printOptionsJson, summarizePlan, type PartPosition, type PrintSettings } from "../export/exportModel";
import { loadExportSettings, saveExportSettings } from "../export/exportSettingsStore";
import {
  IDLE_PRINT_RUN,
  PRINT_BASENAME,
  applyPrintProgress,
  cancelPrintRun,
  exportableFiles,
  failPrintRun,
  fileUrl,
  finishPrintRun,
  plateFilePath,
  printWorkDirectory,
  startPrintRun,
  type PrintRunState,
} from "../export/printRunModel";
import { copyFile } from "../native/BundledAssets";
import { pickDirectory, revealInFinder } from "../native/FilePicker";
import { defaultJoinPath } from "../workspace/Project";
import { PrintPlanSurfaceView, type PrintPlanSurfaceHandle } from "../print/PrintPlanSurfaceView";
import type { PlateViewPart, PrintPlanSurfaceEvent } from "../protocol/surfaces/printplan";

export interface PrintTabProps {
  readonly projectRoot: string;
  readonly coordinator: ExportCoordinator;
  /** Builds a worker request for the current inputs and unsaved source edits; `null` before a template exists. */
  readonly buildJobInput: (kind: ExportJobKind, outputDirectory: string, options: unknown, basename: string) => ExportJobInput | null;
}

const LEFT_WIDTH = 300;
const RIGHT_WIDTH = 320;
const EDGE = 12;

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <Stack direction="row" gap="xs" wrap>
        {options.map((option) => (
          <Button key={option.id} label={option.label} size="compact" disabled={disabled} tone={option.id === value ? "action" : "neutral"} onPress={() => onChange(option.id)} />
        ))}
      </Stack>
    </Field>
  );
}

/** Determinate when `fraction` is known, otherwise a sliding segment so a long first step never looks frozen. */
function ProgressBar({ fraction }: { readonly fraction: number | null }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (fraction !== null) return;
    const timer = setInterval(() => setTick((value) => (value + 1) % 40), 60);
    return () => clearInterval(timer);
  }, [fraction]);
  const SEGMENT = 28;
  const left = fraction === null ? (tick / 40) * (100 - SEGMENT) * 2 : 0;
  const offset = left > 100 - SEGMENT ? 2 * (100 - SEGMENT) - left : left; // ping-pong
  return (
    <View style={{ height: 6, borderRadius: radius.control, backgroundColor: colors.surface.control, overflow: "hidden" }}>
      <View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: fraction === null ? `${offset}%` : 0,
          width: fraction === null ? `${SEGMENT}%` : `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`,
          borderRadius: radius.control,
          backgroundColor: colors.accent.action,
        }}
      />
    </View>
  );
}

export function PrintTab({ projectRoot, coordinator, buildJobInput }: PrintTabProps) {
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_PRINT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [run, setRun] = useState<PrintRunState>(IDLE_PRINT_RUN);
  const [ranWith, setRanWith] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // Parts the user dragged, by node id. Cleared whenever plates are regenerated.
  const [moved, setMoved] = useState<Readonly<Record<string, PartPosition>>>({});
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: "success" | "error"; readonly text: string; readonly reveal: string | null } | null>(null);
  const jobRef = useRef<ExportJobHandle | null>(null);
  const surfaceRef = useRef<PrintPlanSurfaceHandle>(null);
  const mounted = useRef(true);
  const workDirectory = useMemo(() => printWorkDirectory(projectRoot), [projectRoot]);
  const running = run.phase === "running";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    loadExportSettings(projectRoot).then((saved) => {
      if (!mounted.current) return;
      setSettings(saved.print);
      setLoaded(true);
    });
  }, [projectRoot]);

  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => void saveExportSettings(projectRoot, { print: settings }).catch(() => {}), 400);
    return () => clearTimeout(timer);
  }, [loaded, projectRoot, settings]);

  // Show the first plate as soon as it exists; afterwards the user's pick stands.
  useEffect(() => {
    if (selected === null) {
      const first = Object.keys(run.files).map(Number).sort((a, b) => a - b)[0];
      if (first !== undefined) setSelected(first);
    }
  }, [run.files, selected]);

  const settingsKey = JSON.stringify(settings);
  const stale = ranWith !== null && ranWith !== settingsKey && !running;

  const generate = useCallback(async () => {
    const input = buildJobInput("print_plan", workDirectory, printOptionsJson(settings, true, true), PRINT_BASENAME);
    if (!input) {
      setRun(failPrintRun(startPrintRun(run), "The project is not ready yet — open a project with a template first."));
      return;
    }
    setNotice(null);
    setSelected(null);
    setMoved({});
    setRanWith(settingsKey);
    let state = startPrintRun(run);
    setRun(state);
    const handle = coordinator.run(input, (progress) => {
      state = applyPrintProgress(state, progress);
      if (mounted.current) setRun(state);
    });
    jobRef.current = handle;
    const outcome = await handle.outcome;
    jobRef.current = null;
    if (!mounted.current) return;
    if (outcome.kind === "completed") {
      const plan = asPrintPlan(outcome.result);
      setRun(plan ? finishPrintRun(state, plan) : failPrintRun(state, "The worker returned an unreadable print plan."));
    } else if (outcome.kind === "failed") {
      setRun(failPrintRun(state, outcome.message));
    } else {
      setRun(cancelPrintRun(state));
    }
  }, [buildJobInput, coordinator, run, settings, settingsKey, workDirectory]);

  const exportFiles = useCallback(async () => {
    const names = exportableFiles(run);
    if (names.length === 0) return;
    const directory = await pickDirectory("Export", "Choose a folder for the print plate files");
    if (directory === null) return;
    try {
      if (Object.keys(moved).length === 0) {
        for (const name of names) await copyFile(plateFilePath(workDirectory, name), defaultJoinPath(directory, name));
        if (mounted.current) setNotice({ tone: "success", text: `Wrote ${names.length - 1} plate ${names.length - 1 === 1 ? "file" : "files"} to ${directory}`, reveal: directory });
        return;
      }
      // The plate files on disk hold the packed layout; re-plan with the moved parts to write the edited one.
      const input = buildJobInput("print_plan", directory, printOptionsJson(settings, true, false, moved), PRINT_BASENAME);
      if (!input) throw new Error("The project is not ready yet.");
      setExporting("Exporting your layout…");
      const handle = coordinator.run(input, (progress) => {
        if (mounted.current) setExporting(progress.message || "Exporting your layout…");
      });
      jobRef.current = handle;
      const outcome = await handle.outcome;
      jobRef.current = null;
      if (!mounted.current) return;
      setExporting(null);
      if (outcome.kind === "failed") throw new Error(outcome.message);
      if (outcome.kind === "completed") {
        const count = asPrintPlan(outcome.result)?.plates.length ?? 0;
        setNotice({ tone: "success", text: `Wrote ${count} plate ${count === 1 ? "file" : "files"} (with your edits) to ${directory}`, reveal: directory });
      }
    } catch (error) {
      jobRef.current = null;
      if (mounted.current) {
        setExporting(null);
        setNotice({ tone: "error", text: `Export failed: ${String(error)}`, reveal: null });
      }
    }
  }, [buildJobInput, coordinator, moved, run, settings, workDirectory]);

  const onSurfaceEvent = useCallback((event: PrintPlanSurfaceEvent) => {
    if (event.kind === "partMoved") setMoved((current) => ({ ...current, [event.id]: { x: event.x, y: event.y } }));
  }, []);

  const resetLayout = useCallback(() => {
    setMoved({});
    setLayoutVersion((value) => value + 1);
  }, []);

  const change = useCallback((update: (current: PrintSettings) => PrintSettings) => setSettings(update), []);

  const plan = run.plan;
  const plate = plan?.plates.find((item) => item.index === selected) ?? null;
  const plateFile = selected !== null ? run.files[selected] : undefined;
  const plateUrl = plateFile ? fileUrl(plateFilePath(workDirectory, plateFile)) : null;
  const bed = useMemo(
    () => ({
      bedX: settings.printer.bedX,
      bedY: settings.printer.bedY,
      maxZ: settings.printer.maxZ,
      origin: settings.printer.origin,
      margin: settings.printer.bedMargin,
    }),
    [settings.printer.bedX, settings.printer.bedY, settings.printer.maxZ, settings.printer.origin, settings.printer.bedMargin],
  );
  // Parts as the viewer needs them: current position (edited if moved) and where the STL file has them.
  // Read by the viewer only when a plate (re)loads, so edits made in the viewer are never echoed back.
  const viewParts = useMemo<readonly PlateViewPart[]>(
    () =>
      (plate?.parts ?? []).map((part) => ({
        id: part.node_id,
        x: moved[part.node_id]?.x ?? part.x,
        y: moved[part.node_id]?.y ?? part.y,
        originX: part.x,
        originY: part.y,
        width: part.width,
        depth: part.depth,
      })),
    [plate, moved],
  );
  const edited = Object.keys(moved).length;
  const canExport = exportableFiles(run).length > 0 && !running && exporting === null;
  const empty = run.phase === "done" && (plan?.plates.length ?? 0) === 0;

  return (
    <View style={{ flex: 1 }}>
      <PrintPlanSurfaceView ref={surfaceRef} bed={bed} plateUrl={plateUrl} plateKey={`${run.runId}:${selected ?? "-"}:${plateFile ?? "-"}:${layoutVersion}`}
        parts={viewParts}
        onSurfaceEvent={onSurfaceEvent}
      />

      {/* Left: printer + generate */}
      <View pointerEvents="box-none" style={{ position: "absolute", top: EDGE, left: EDGE, bottom: EDGE, width: LEFT_WIDTH }}>
        <Panel surface="panel" padding="md" elevated bordered>
          <ScrollView>
            <Stack gap="md">
              <Text variant="heading">3D Print</Text>
              <Text variant="label" tone="secondary">
                Lays printed parts flat — one plate per filament, more plates when a bed fills — and writes one STL per plate for your slicer.
              </Text>
              <Field label="Printer name">
                <TextField accessibilityLabel="Printer name" value={settings.printer.name} onChangeText={(name) => change((s) => ({ ...s, printer: { ...s.printer, name } }))} />
              </Field>
              <Stack direction="row" gap="sm" wrap>
                <Field label="Bed X">
                  <NumericInput accessibilityLabel="Bed X" unit="mm" min={1} value={settings.printer.bedX} onChange={(bedX) => change((s) => ({ ...s, printer: { ...s.printer, bedX } }))} />
                </Field>
                <Field label="Bed Y">
                  <NumericInput accessibilityLabel="Bed Y" unit="mm" min={1} value={settings.printer.bedY} onChange={(bedY) => change((s) => ({ ...s, printer: { ...s.printer, bedY } }))} />
                </Field>
                <Field label="Max height">
                  <NumericInput accessibilityLabel="Max height" unit="mm" min={1} value={settings.printer.maxZ} onChange={(maxZ) => change((s) => ({ ...s, printer: { ...s.printer, maxZ } }))} />
                </Field>
                <Field label="Bed margin">
                  <NumericInput accessibilityLabel="Bed margin" unit="mm" min={0} value={settings.printer.bedMargin} onChange={(bedMargin) => change((s) => ({ ...s, printer: { ...s.printer, bedMargin } }))} />
                </Field>
                <Field label="Part spacing">
                  <NumericInput accessibilityLabel="Part spacing" unit="mm" min={0} value={settings.plan.partSpacing} onChange={(partSpacing) => change((s) => ({ ...s, plan: { ...s.plan, partSpacing } }))} />
                </Field>
              </Stack>
              <Choice
                label="Coordinate origin"
                value={settings.printer.origin}
                onChange={(origin) => change((s) => ({ ...s, printer: { ...s.printer, origin } }))}
                options={[
                  { id: "corner", label: "Bed corner" },
                  { id: "center", label: "Bed center" },
                ]}
              />
              <Choice
                label="Orientation"
                value={settings.plan.optimizeOrientation ? "auto" : "asis"}
                onChange={(value) => change((s) => ({ ...s, plan: { ...s.plan, optimizeOrientation: value === "auto" } }))}
                options={[
                  { id: "auto", label: "Least overhang" },
                  { id: "asis", label: "As designed" },
                ]}
              />
              <Stack direction="row" gap="sm" align="center">
                {running ? (
                  <Button label="Cancel" onPress={() => jobRef.current?.cancel()} />
                ) : (
                  <Button label={run.phase === "idle" ? "Generate Plates" : "Regenerate"} tone="action" disabled={!loaded} onPress={() => void generate()} />
                )}
                <Button label="Fit View" size="compact" onPress={() => surfaceRef.current?.fitCamera()} />
              </Stack>
              {stale ? (
                <Text variant="label" tone="action">
                  Settings changed since the last run — regenerate to update the plates.
                </Text>
              ) : null}
            </Stack>
          </ScrollView>
        </Panel>
      </View>

      {/* Right: plates */}
      {plan ? (
        <View pointerEvents="box-none" style={{ position: "absolute", top: EDGE, right: EDGE, bottom: EDGE, width: RIGHT_WIDTH }}>
          <Panel surface="panel" padding="md" elevated bordered>
            <ScrollView>
              <Stack gap="md">
                <Stack gap="xs">
                  <Text variant="heading">Plates</Text>
                  <Text variant="label" tone="secondary">
                    {summarizePlan(plan)}
                  </Text>
                </Stack>
                {empty ? (
                  <Text variant="label" tone="secondary">
                    No printed parts found. Give parts a material whose process is PRINTED.
                  </Text>
                ) : null}
                <Stack gap="xs">
                  {plan.plates.map((item) => {
                    const ready = run.files[item.index] !== undefined;
                    return (
                      <Button
                        key={item.index}
                        label={`Plate ${item.index} · ${item.material} · ${item.parts.length} ${item.parts.length === 1 ? "part" : "parts"}${ready ? "" : " …"}`}
                        size="compact"
                        tone={item.index === selected ? "action" : "neutral"}
                        disabled={!ready}
                        onPress={() => setSelected(item.index)}
                      />
                    );
                  })}
                </Stack>
                {plate ? (
                  <Stack gap="xs">
                    <Text variant="label" tone="secondary">
                      Plate {plate.index} · {plate.material} · up to {Math.round(plate.max_height)} mm tall
                    </Text>
                    {plate.parts.map((part) => (
                      <Text key={part.node_id} variant="label">
                        {part.instance_key}
                        {part.rotated ? "  ↻" : ""}
                        {moved[part.node_id] ? "  ✎" : ""}
                      </Text>
                    ))}
                    <Text variant="label" tone="secondary">
                      Drag a part in the view to move it.
                    </Text>
                  </Stack>
                ) : null}
                {plan.warnings.map((warning) => (
                  <Text key={warning} variant="label" tone="action">
                    {warning}
                  </Text>
                ))}
                {plan.skipped.map((item) => (
                  <Text key={item.node_id} variant="label" tone="action">
                    Skipped {item.instance_key}: {item.reason}
                  </Text>
                ))}
                {edited > 0 ? (
                  <Stack direction="row" gap="sm" align="center">
                    <Text variant="label" tone="action">
                      {edited} {edited === 1 ? "part" : "parts"} moved
                    </Text>
                    <Button label="Reset layout" size="compact" disabled={exporting !== null} onPress={resetLayout} />
                  </Stack>
                ) : null}
                {exporting ? <StatusBadge tone="pending" label={exporting} /> : null}
                <Stack direction="row" gap="sm" align="center">
                  <Button label="Export STLs…" tone="action" disabled={!canExport} onPress={() => void exportFiles()} />
                  {notice?.reveal ? <Button label="Show in Finder" size="compact" onPress={() => void revealInFinder(notice.reveal ?? "")} /> : null}
                </Stack>
                {notice ? <StatusBadge tone={notice.tone} label={notice.text} /> : null}
              </Stack>
            </ScrollView>
          </Panel>
        </View>
      ) : null}

      {/* Bottom: progress / status */}
      {running || run.phase === "failed" || run.phase === "cancelled" ? (
        <View pointerEvents="box-none" style={{ position: "absolute", left: LEFT_WIDTH + EDGE * 2, right: (plan ? RIGHT_WIDTH : 0) + EDGE * 2, bottom: EDGE, alignItems: "center" }}>
          <View style={{ width: "100%", maxWidth: 520 }}>
            <Panel surface="panel" padding="md" elevated bordered>
              {running ? (
                <Stack gap="sm">
                  <Stack direction="row" gap="sm" align="center" justify="space-between">
                    <Text variant="label">{run.label}</Text>
                    {run.fraction !== null ? (
                      <Text variant="label" tone="secondary" numeric>
                        {Math.round(run.fraction * 100)}%
                      </Text>
                    ) : null}
                  </Stack>
                  <ProgressBar fraction={run.fraction} />
                  {plan ? (
                    <Text variant="label" tone="secondary" numeric>
                      {Object.keys(run.files).length} of {plan.plates.length} plates ready
                    </Text>
                  ) : null}
                </Stack>
              ) : run.phase === "failed" ? (
                <StatusBadge tone="error" label={run.error ?? "Plate generation failed."} />
              ) : (
                <StatusBadge tone="pending" label="Cancelled" />
              )}
            </Panel>
          </View>
        </View>
      ) : null}

      {run.phase === "idle" ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: LEFT_WIDTH + EDGE * 2, right: EDGE, alignItems: "center", justifyContent: "center" }}>
          <Text tone="secondary">Set up your printer, then Generate Plates to see them on the bed.</Text>
        </View>
      ) : null}
    </View>
  );
}
