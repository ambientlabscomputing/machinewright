/**
 * Purchased-parts BOM: the lines come from Machinewright's own BOM (the
 * `bom.json` every evaluation writes — `lib/bom.py`'s `generate_structured_bom`),
 * so grouping, identity and quantities have exactly one implementation. This
 * module only parses that file, keeps the purchased lines, and layers the user's
 * procurement data (supplier, price, order status…) on top.
 *
 * Procurement data is keyed by the BOM line's own `line_id` (a content digest of
 * definition + revision + parameters), so it survives edits that don't change a
 * part, and entries for parts that leave the design are kept (not deleted) in
 * case they come back. Pure and UI-free.
 */

export type OrderStatus = "to_order" | "ordered" | "received" | "on_hand";

export const ORDER_STATUSES: readonly { readonly id: OrderStatus; readonly label: string }[] = [
  { id: "to_order", label: "To order" },
  { id: "ordered", label: "Ordered" },
  { id: "received", label: "Received" },
  { id: "on_hand", label: "On hand" },
];

export interface Procurement {
  readonly supplier: string;
  readonly sku: string;
  readonly url: string;
  /** Price of one unit in the BOM's currency; `null` when unknown. */
  readonly unitCost: number | null;
  /** Extra units to buy beyond the design's need (spare fasteners, losses). */
  readonly spares: number;
  readonly status: OrderStatus;
  readonly notes: string;
}

export const EMPTY_PROCUREMENT: Procurement = {
  supplier: "",
  sku: "",
  url: "",
  unitCost: null,
  spares: 0,
  status: "to_order",
  notes: "",
};

export interface BomLine {
  /** The canonical BOM `line_id`; the key procurement data is stored under. */
  readonly key: string;
  readonly definitionId: string;
  readonly revision: string;
  /** Short human summary of the part's parameters, e.g. "length=18 · diameter=3". */
  readonly parameterSummary: string;
  readonly manufacturer: string;
  readonly partNumber: string;
  readonly material: string;
  readonly quantity: number;
  /** Graph node ids of every instance (the BOM's `source_instances`). */
  readonly nodeIds: readonly string[];
  /** Instance names, i.e. the last segment of each node id. */
  readonly instanceKeys: readonly string[];
}

/** File name of the canonical BOM an evaluation writes next to its other artifacts (see `export_service`). */
export function bomArtifactName(graphDigest: string): string {
  const hex = graphDigest.split(":")[1] ?? graphDigest;
  return `assembly-${hex.slice(0, 12)}.bom.json`;
}

function summarizeParameters(parameters: unknown): string {
  if (typeof parameters !== "object" || parameters === null) return "";
  return Object.entries(parameters as Record<string, unknown>)
    .filter(([name, value]) => name !== "definition_id" && ["string", "number", "boolean"].includes(typeof value))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(" · ");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Is this canonical BOM line a purchased part? `material_process` is authoritative;
 * BOM files written before it existed fall back to the line's process id.
 */
function isPurchased(line: Record<string, unknown>): boolean {
  if (typeof line.material_process === "string") return line.material_process === "PURCHASED";
  const process = line.process as { process_id?: unknown } | null | undefined;
  return process?.process_id === "purchased";
}

/**
 * Purchased lines of a canonical BOM document (the text of `bom.json`), in the
 * file's own order (sorted by definition then parameters). Throws on a document
 * that is not a BOM; the caller reports it.
 */
export function parseCanonicalBom(source: string): readonly BomLine[] {
  const document = JSON.parse(source) as { lines?: unknown };
  if (!Array.isArray(document.lines)) throw new Error("not a Machinewright BOM (no lines)");
  const lines: BomLine[] = [];
  for (const raw of document.lines as Record<string, unknown>[]) {
    if (!isPurchased(raw)) continue;
    const manufacturer = (raw.manufacturer_part ?? {}) as Record<string, unknown>;
    const nodeIds = Array.isArray(raw.source_instances) ? raw.source_instances.filter((id): id is string => typeof id === "string") : [];
    lines.push({
      key: str(raw.line_id),
      definitionId: str(raw.definition_id),
      revision: str(raw.definition_revision),
      parameterSummary: summarizeParameters(raw.parameters),
      manufacturer: str(manufacturer.manufacturer),
      partNumber: str(manufacturer.part_number),
      material: str(raw.material),
      quantity: Number(raw.quantity),
      nodeIds,
      instanceKeys: nodeIds.map((id) => id.split("/").pop() ?? id),
    });
  }
  return lines;
}

// --- Procurement store ---------------------------------------------------------------

export interface ProcurementData {
  readonly currency: string;
  readonly lines: Readonly<Record<string, Procurement>>;
}

export const EMPTY_PROCUREMENT_DATA: ProcurementData = { currency: "USD", lines: {} };

/** Lives in the project root so it can be committed alongside the design. */
export const PROCUREMENT_FILE = "bom-procurement.json";

export function procurementPath(projectRoot: string): string {
  return `${projectRoot.replace(/\/+$/, "")}/${PROCUREMENT_FILE}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalize(raw: unknown): Procurement {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = ORDER_STATUSES.find((item) => item.id === r.status)?.id ?? EMPTY_PROCUREMENT.status;
  const rawCost = r.unit_cost ?? r.unitCost; // `unitCost`: files from early app versions
  const cost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;
  const spares = typeof r.spares === "number" && Number.isFinite(r.spares) && r.spares >= 0 ? Math.floor(r.spares) : 0;
  return { supplier: text(r.supplier), sku: text(r.sku), url: text(r.url), unitCost: cost, spares, status, notes: text(r.notes) };
}

/** Tolerant parse: a missing, hand-edited or malformed file degrades to defaults field by field. */
export function parseProcurement(source: string): ProcurementData {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return EMPTY_PROCUREMENT_DATA;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_PROCUREMENT_DATA;
  const root = raw as Record<string, unknown>;
  const lines: Record<string, Procurement> = {};
  if (typeof root.lines === "object" && root.lines !== null && !Array.isArray(root.lines)) {
    for (const [key, value] of Object.entries(root.lines)) lines[key] = normalize(value);
  }
  const currency = typeof root.currency === "string" && root.currency.trim() ? root.currency.trim() : EMPTY_PROCUREMENT_DATA.currency;
  return { currency, lines };
}

/**
 * Stable, diff-friendly output in the shared `ProcurementFile` schema (Python's `lib/procurement.py`
 * reads and writes the same file): keys sorted, entries equal to the defaults omitted.
 */
export function serializeProcurement(data: ProcurementData): string {
  const lines: Record<string, unknown> = {};
  for (const key of Object.keys(data.lines).sort()) {
    const entry = data.lines[key]!;
    if (JSON.stringify(entry) === JSON.stringify(EMPTY_PROCUREMENT)) continue;
    const { unitCost, ...rest } = entry;
    lines[key] = { supplier: rest.supplier, sku: rest.sku, url: rest.url, unit_cost: unitCost, spares: rest.spares, status: rest.status, notes: rest.notes };
  }
  return JSON.stringify({ schema_version: "1.0", currency: data.currency, lines }, null, 2) + "\n";
}

export function procurementFor(data: ProcurementData, key: string): Procurement {
  return data.lines[key] ?? EMPTY_PROCUREMENT;
}

export function updateProcurement(data: ProcurementData, key: string, patch: Partial<Procurement>): ProcurementData {
  return { ...data, lines: { ...data.lines, [key]: { ...procurementFor(data, key), ...patch } } };
}

// --- Totals & views --------------------------------------------------------------------

/** Units to buy: what the design needs plus spares. */
export function orderQuantity(line: BomLine, procurement: Procurement): number {
  return line.quantity + procurement.spares;
}

export function extendedCost(line: BomLine, procurement: Procurement): number | null {
  return procurement.unitCost === null ? null : procurement.unitCost * orderQuantity(line, procurement);
}

export interface BomTotals {
  readonly lines: number;
  readonly units: number;
  /** Sum over priced lines only. */
  readonly cost: number;
  readonly unpriced: number;
  readonly byStatus: Readonly<Record<OrderStatus, number>>;
}

export function computeTotals(lines: readonly BomLine[], data: ProcurementData): BomTotals {
  const byStatus: Record<OrderStatus, number> = { to_order: 0, ordered: 0, received: 0, on_hand: 0 };
  let units = 0;
  let cost = 0;
  let unpriced = 0;
  for (const line of lines) {
    const procurement = procurementFor(data, line.key);
    units += orderQuantity(line, procurement);
    byStatus[procurement.status] += 1;
    const extended = extendedCost(line, procurement);
    if (extended === null) unpriced += 1;
    else cost += extended;
  }
  return { lines: lines.length, units, cost, unpriced, byStatus };
}

export function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
