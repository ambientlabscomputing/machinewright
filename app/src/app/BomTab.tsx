/**
 * The BOM tab: purchased parts of the evaluated design, grouped into lines, with
 * the procurement data (supplier, price, spares, order status, notes) you keep
 * for each. The design decides what is listed and how many; everything else is
 * yours and lives in `bom-procurement.json` in the project root.
 *
 * Layout mirrors the 3D Print tab: a full-window main area (the table) with
 * floating tool boxes — a summary/filter bar on top and a detail editor for the
 * selected line on the right.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { Button, Field, NumericInput, Panel, Stack, StatusBadge, Text, TextField } from "../design-system/native";
import { colors } from "../design-system/tokens/colors";
import { radius } from "../design-system/tokens/shape";
import { spacing } from "../design-system/tokens/spacing";
import {
  EMPTY_PROCUREMENT_DATA,
  ORDER_STATUSES,
  bomArtifactName,
  mergeSynced,
  computeTotals,
  extendedCost,
  formatMoney,
  orderQuantity,
  parseCanonicalBom,
  parseProcurement,
  procurementFor,
  PROCUREMENT_FILE,
  procurementPath,
  serializeProcurement,
  updateProcurement,
  type BomLine,
  type OrderStatus,
  type Procurement,
  type ProcurementData,
} from "../bom/bomModel";
import { readTextFile, writeTextFileAtomically } from "../native/BundledAssets";
import { pickDirectory, revealInFinder } from "../native/FilePicker";
import type { ExportCoordinator, ExportJobInput, ExportJobKind } from "../export/ExportCoordinator";
import { exportStem } from "../export/exportModel";

export interface BomTabProps {
  readonly projectId: string;
  readonly projectRoot: string;
  /** Where evaluations write their artifacts, including the canonical `bom.json`. */
  readonly outputDirectory: string;
  /** Graph digest of the accepted snapshot, or `null` before the first evaluation completes. */
  readonly graphDigest: string | null;
  /** Select these graph nodes in the workspace viewport and switch to it. */
  readonly onShowInViewport: (nodeIds: readonly string[]) => void;
  /** The CSV (BOM + sourcing) is written by the worker, from the same code the CLI uses. */
  readonly coordinator: ExportCoordinator;
  readonly buildJobInput: (kind: ExportJobKind, outputDirectory: string, options: unknown, basename: string) => ExportJobInput | null;
  /** Latest batch of changed project-relative paths from the filesystem watcher (null before any). */
  readonly fsChange?: { readonly paths: readonly string[] } | null;
}

const EDGE = 12;
const DETAIL_WIDTH = 340;
const TOOLBAR_HEIGHT = 64;

type Filter = "all" | OrderStatus;

// Column flex weights; one source for header and rows so they stay aligned.
const COLUMNS = [
  { id: "item", label: "#", flex: 0.4, align: "left" },
  { id: "part", label: "Part", flex: 3, align: "left" },
  { id: "mpn", label: "Manufacturer · MPN", flex: 2.4, align: "left" },
  { id: "qty", label: "Qty", flex: 0.8, align: "right" },
  { id: "order", label: "Order", flex: 0.8, align: "right" },
  { id: "supplier", label: "Supplier", flex: 1.6, align: "left" },
  { id: "unit", label: "Unit", flex: 1, align: "right" },
  { id: "ext", label: "Extended", flex: 1.2, align: "right" },
  { id: "status", label: "Status", flex: 1.1, align: "left" },
] as const;

function Cell({ column, children, tone, numeric }: { readonly column: (typeof COLUMNS)[number]; readonly children: string; readonly tone?: "secondary" | "primary" | "action"; readonly numeric?: boolean }) {
  return (
    <View style={{ flex: column.flex, paddingHorizontal: spacing.xs, alignItems: column.align === "right" ? "flex-end" : "flex-start" }}>
      <Text variant="label" tone={tone ?? "primary"} numeric={numeric} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

/** Cost entry as text so partial input ("1.") survives; empty means unknown. */
function CostField({ value, onChange }: { readonly value: number | null; readonly onChange: (value: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value === null ? "" : String(value));
    }
  }, [value]);
  return (
    <TextField
      accessibilityLabel="Unit cost"
      placeholder="unknown"
      value={text}
      onChangeText={(next) => {
        setText(next);
        const trimmed = next.trim();
        const parsed = trimmed === "" ? null : Number(trimmed);
        if (parsed === null || (Number.isFinite(parsed) && parsed >= 0)) {
          last.current = parsed;
          onChange(parsed);
        }
      }}
    />
  );
}

export function BomTab({ projectId, projectRoot, outputDirectory, graphDigest, onShowInViewport, coordinator, buildJobInput, fsChange = null }: BomTabProps) {
  const [data, setData] = useState<ProcurementData>(EMPTY_PROCUREMENT_DATA);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: "success" | "error"; readonly text: string; readonly reveal: string | null } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    readTextFile(procurementPath(projectRoot))
      .catch(() => "")
      .then((text) => {
        if (!mounted.current) return;
        setData(parseProcurement(text));
        setLoaded(true);
      });
  }, [projectRoot]);

  // Prefill the file for this design (one blank, readable entry per purchased part, with its
  // `needs`) — Python does it, so the app, the CLI and agents all see the same file. Whatever the
  // user has typed meanwhile wins over the file.
  useEffect(() => {
    if (!graphDigest || !loaded) return;
    const input = buildJobInput("bom_sourcing", outputDirectory, { project_root: projectRoot, action: "sync" }, exportStem(projectId));
    if (!input) return;
    let cancelled = false;
    coordinator
      .run(input, () => {})
      .outcome.then(async (outcome) => {
        if (outcome.kind !== "completed" || cancelled || !mounted.current) return;
        const synced = parseProcurement(await readTextFile(procurementPath(projectRoot)).catch(() => ""));
        if (!cancelled && mounted.current) setData((current) => mergeSynced(current, synced));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Re-sync when the design changes, not on every render of the props.
  }, [graphDigest, loaded, projectRoot]);

  // Only write once the file has been read (never clobber it with defaults) and only after real edits.
  // `dirty` stays true from the first edit until its write lands, so an external change arriving in
  // that window never overwrites what the user just typed. `lastWritten` lets the watcher recognise
  // our own writes and ignore them.
  const dirty = useRef(false);
  const lastWritten = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const timer = setTimeout(() => {
      const text = serializeProcurement(data);
      lastWritten.current = text;
      writeTextFileAtomically(procurementPath(projectRoot), text).then(
        () => {
          if (lastWritten.current === text) dirty.current = false;
        },
        (error: unknown) => setNotice({ tone: "error", text: `Could not save procurement data: ${String(error)}`, reveal: null }),
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [loaded, projectRoot, data]);

  // Stay fresh with the disk: when `bom-procurement.json` changes outside the app (an agent, the
  // CLI, git, an editor tab), reload it. Our own writes and in-flight edits are skipped.
  useEffect(() => {
    if (!fsChange || !loaded) return;
    if (!fsChange.paths.some((path) => path === PROCUREMENT_FILE)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      readTextFile(procurementPath(projectRoot))
        .catch(() => null)
        .then((text) => {
          if (cancelled || !mounted.current || text === null) return;
          if (dirty.current || text === lastWritten.current) return;
          lastWritten.current = text;
          setData(parseProcurement(text));
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fsChange, loaded, projectRoot]);

  const edit = useCallback((key: string, patch: Partial<Procurement>) => {
    dirty.current = true;
    setData((current) => updateProcurement(current, key, patch));
  }, []);

  // The BOM itself is Machinewright's: read the bom.json the evaluation wrote for this exact graph.
  const [bom, setBom] = useState<{ readonly digest: string | null; readonly lines: readonly BomLine[]; readonly error: string | null }>({ digest: null, lines: [], error: null });
  useEffect(() => {
    if (!graphDigest) return;
    let cancelled = false;
    readTextFile(`${outputDirectory.replace(/\/+$/, "")}/${bomArtifactName(graphDigest)}`)
      .then((text) => {
        if (!cancelled) setBom({ digest: graphDigest, lines: parseCanonicalBom(text), error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setBom((current) => ({ ...current, error: `Could not read the design's BOM (${String(error)}).` }));
      });
    return () => {
      cancelled = true;
    };
  }, [graphDigest, outputDirectory]);
  const lines = bom.lines;
  const totals = useMemo(() => computeTotals(lines, data), [lines, data]);
  const visible = useMemo(() => (filter === "all" ? lines : lines.filter((line) => procurementFor(data, line.key).status === filter)), [lines, data, filter]);
  const selected = lines.find((line) => line.key === selectedKey) ?? null;

  const exportCsv = useCallback(async () => {
    const directory = await pickDirectory("Export", "Choose a folder for the purchased-parts CSV");
    if (directory === null) return;
    try {
      // The worker reads the procurement file from disk, so save pending edits first.
      const saved = serializeProcurement(data);
      lastWritten.current = saved;
      await writeTextFileAtomically(procurementPath(projectRoot), saved);
      dirty.current = false;
      const input = buildJobInput("bom_sourcing", directory, { project_root: projectRoot }, exportStem(projectId));
      if (!input) throw new Error("The project is not ready yet.");
      const outcome = await coordinator.run(input, () => {}).outcome;
      if (outcome.kind === "failed") throw new Error(outcome.message);
      if (outcome.kind === "completed" && mounted.current) {
        const file = (outcome.result as { file?: string } | null)?.file ?? "";
        setNotice({ tone: "success", text: `Saved ${file} to ${directory}`, reveal: directory });
      }
    } catch (error) {
      if (mounted.current) setNotice({ tone: "error", text: `Export failed: ${String(error)}`, reveal: null });
    }
  }, [buildJobInput, coordinator, data, projectId, projectRoot]);

  const money = (amount: number) => formatMoney(amount, data.currency);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface.display }}>
      {/* Main: the table */}
      <View style={{ position: "absolute", top: TOOLBAR_HEIGHT + EDGE * 2, left: EDGE, bottom: EDGE, right: selected ? DETAIL_WIDTH + EDGE * 2 : EDGE }}>
        <Panel surface="panel" padding="none" flex={1} bordered>
          <View style={{ flexDirection: "row", paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border.subtle }}>
            {COLUMNS.map((column) => (
              <Cell key={column.id} column={column} tone="secondary">
                {column.label}
              </Cell>
            ))}
          </View>
          {lines.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <Text tone="secondary">
                {bom.error
                  ? bom.error
                  : bom.digest
                    ? "This design has no purchased parts. Parts whose material process is PURCHASED appear here."
                    : "Waiting for the design to evaluate…"}
              </Text>
            </View>
          ) : visible.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <Text tone="secondary">No lines with this status.</Text>
            </View>
          ) : (
            <ScrollView>
              {visible.map((line) => (
                <Row
                  key={line.key}
                  line={line}
                  item={lines.indexOf(line) + 1}
                  procurement={procurementFor(data, line.key)}
                  selected={line.key === selectedKey}
                  money={money}
                  onPress={() => setSelectedKey(line.key === selectedKey ? null : line.key)}
                />
              ))}
            </ScrollView>
          )}
        </Panel>
      </View>

      {/* Top: summary, filter, export */}
      <View pointerEvents="box-none" style={{ position: "absolute", top: EDGE, left: EDGE, right: EDGE, height: TOOLBAR_HEIGHT }}>
        <Panel surface="panel" padding="md" elevated bordered>
          <Stack direction="row" gap="md" align="center" wrap>
            <Text variant="heading">Purchased parts</Text>
            <Text variant="label" tone="secondary" numeric>
              {totals.lines} {totals.lines === 1 ? "line" : "lines"} · {totals.units} units to buy · {money(totals.cost)}
              {totals.unpriced > 0 ? ` (${totals.unpriced} unpriced)` : ""}
            </Text>
            <Stack direction="row" gap="xs" align="center">
              <Button label="All" size="compact" tone={filter === "all" ? "action" : "neutral"} onPress={() => setFilter("all")} />
              {ORDER_STATUSES.map((status) => (
                <Button
                  key={status.id}
                  label={`${status.label} ${totals.byStatus[status.id]}`}
                  size="compact"
                  tone={filter === status.id ? "action" : "neutral"}
                  onPress={() => setFilter(status.id)}
                />
              ))}
            </Stack>
            <View style={{ width: 84 }}>
              <TextField
                accessibilityLabel="Currency"
                value={data.currency}
                onChangeText={(currency) => {
                  dirty.current = true;
                  setData((current) => ({ ...current, currency: currency.toUpperCase().slice(0, 6) }));
                }}
              />
            </View>
            <Button label="Export CSV…" tone="action" disabled={lines.length === 0} onPress={() => void exportCsv()} />
            {notice ? <StatusBadge tone={notice.tone} label={notice.text} /> : null}
            {notice?.reveal ? <Button label="Show in Finder" size="compact" onPress={() => void revealInFinder(notice.reveal ?? "")} /> : null}
          </Stack>
        </Panel>
      </View>

      {/* Right: selected line */}
      {selected ? (
        <View pointerEvents="box-none" style={{ position: "absolute", top: TOOLBAR_HEIGHT + EDGE * 2, right: EDGE, bottom: EDGE, width: DETAIL_WIDTH }}>
          <Panel surface="panel" padding="md" elevated bordered>
            <ScrollView>
              <Detail
                line={selected}
                procurement={procurementFor(data, selected.key)}
                currency={data.currency}
                onChange={(patch) => edit(selected.key, patch)}
                onShow={() => onShowInViewport(selected.nodeIds)}
                onClose={() => setSelectedKey(null)}
              />
            </ScrollView>
          </Panel>
        </View>
      ) : null}
    </View>
  );
}

function Row({ line, item, procurement, selected, money, onPress }: {
  readonly line: BomLine;
  readonly item: number;
  readonly procurement: Procurement;
  readonly selected: boolean;
  readonly money: (amount: number) => string;
  readonly onPress: () => void;
}) {
  const extended = extendedCost(line, procurement);
  const status = ORDER_STATUSES.find((s) => s.id === procurement.status)?.label ?? "";
  const cells: Record<(typeof COLUMNS)[number]["id"], string> = {
    item: String(item),
    part: line.parameterSummary ? `${line.definitionId}  ${line.parameterSummary}` : line.definitionId,
    mpn: [line.manufacturer, line.partNumber].filter(Boolean).join(" · ") || "—",
    qty: String(line.quantity),
    order: String(orderQuantity(line, procurement)),
    supplier: procurement.supplier || "—",
    unit: procurement.unitCost === null ? "—" : money(procurement.unitCost),
    ext: extended === null ? "—" : money(extended),
    status,
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`BOM line ${item}: ${line.definitionId}`}
      style={{
        flexDirection: "row",
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm,
        borderRadius: radius.control,
        backgroundColor: selected ? colors.surface.control : "transparent",
      }}
    >
      {COLUMNS.map((column) => (
        <Cell
          key={column.id}
          column={column}
          numeric={column.align === "right"}
          tone={column.id === "status" && procurement.status === "to_order" ? "action" : cells[column.id] === "—" ? "secondary" : "primary"}
        >
          {cells[column.id]}
        </Cell>
      ))}
    </Pressable>
  );
}

function Detail({ line, procurement, currency, onChange, onShow, onClose }: {
  readonly line: BomLine;
  readonly procurement: Procurement;
  readonly currency: string;
  readonly onChange: (patch: Partial<Procurement>) => void;
  readonly onShow: () => void;
  readonly onClose: () => void;
}) {
  const extended = extendedCost(line, procurement);
  return (
    <Stack gap="md">
      <Stack direction="row" gap="sm" align="center" justify="space-between">
        <Text variant="heading">Line details</Text>
        <Button label="Close" size="compact" onPress={onClose} />
      </Stack>
      <Stack gap="xs">
        <Text>{line.definitionId}</Text>
        {line.parameterSummary ? (
          <Text variant="label" tone="secondary">
            {line.parameterSummary}
          </Text>
        ) : null}
        {line.manufacturer || line.partNumber ? (
          <Text variant="label" tone="secondary">
            {[line.manufacturer, line.partNumber].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
        <Text variant="label" tone="secondary" numeric>
          Design needs {line.quantity} · buy {line.quantity + procurement.spares}
          {extended !== null ? ` · ${extended.toFixed(2)} ${currency}` : ""}
        </Text>
      </Stack>
      <Field label="Status">
        <Stack direction="row" gap="xs" wrap>
          {ORDER_STATUSES.map((status) => (
            <Button key={status.id} label={status.label} size="compact" tone={status.id === procurement.status ? "action" : "neutral"} onPress={() => onChange({ status: status.id })} />
          ))}
        </Stack>
      </Field>
      <Field label="Supplier">
        <TextField accessibilityLabel="Supplier" value={procurement.supplier} onChangeText={(supplier) => onChange({ supplier })} />
      </Field>
      <Field label="Supplier SKU">
        <TextField accessibilityLabel="Supplier SKU" value={procurement.sku} onChangeText={(sku) => onChange({ sku })} />
      </Field>
      <Field label="Product link">
        <TextField accessibilityLabel="Product link" placeholder="https://…" value={procurement.url} onChangeText={(url) => onChange({ url })} />
      </Field>
      {/^https?:\/\//i.test(procurement.url.trim()) ? (
        <Stack direction="row">
          <Button label="Open Link" size="compact" onPress={() => void Linking.openURL(procurement.url.trim())} />
        </Stack>
      ) : null}
      <Stack direction="row" gap="md">
        <Field label={`Unit cost (${currency})`}>
          <CostField value={procurement.unitCost} onChange={(unitCost) => onChange({ unitCost })} />
        </Field>
        <Field label="Spares">
          <NumericInput accessibilityLabel="Spares" min={0} value={procurement.spares} onChange={(spares) => onChange({ spares: Math.floor(spares) })} />
        </Field>
      </Stack>
      <Field label="Notes">
        <TextField accessibilityLabel="Notes" value={procurement.notes} onChangeText={(notes) => onChange({ notes })} />
      </Field>
      <Stack gap="xs">
        <Text variant="label" tone="secondary">
          Used by {line.instanceKeys.length} {line.instanceKeys.length === 1 ? "instance" : "instances"}
        </Text>
        {line.instanceKeys.map((key) => (
          <Text key={key} variant="label">
            {key}
          </Text>
        ))}
        <Stack direction="row">
          <Button label="Show in Viewport" size="compact" onPress={onShow} />
        </Stack>
      </Stack>
    </Stack>
  );
}
