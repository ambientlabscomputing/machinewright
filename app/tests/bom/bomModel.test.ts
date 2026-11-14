import { describe, expect, it } from "vitest";
import {
  EMPTY_PROCUREMENT,
  EMPTY_PROCUREMENT_DATA,
  bomArtifactName,
  computeTotals,
  extendedCost,
  parseCanonicalBom,
  parseProcurement,
  serializeProcurement,
  updateProcurement,
} from "../../src/bom/bomModel";

// Shaped like `canonical_json(generate_structured_bom(graph))`: decimals are strings.
const line = (id: string, def: string, quantity: string, extra: object = {}) => ({
  line_id: `sha256:${id}`,
  definition_id: def,
  definition_revision: "1",
  parameters: { definition_id: def, length: "18", name: "M3" },
  quantity,
  material: "Off-the-shelf hardware",
  material_process: "PURCHASED",
  source_instances: Array.from({ length: Number(quantity) }, (_, i) => `r/${id}-${i + 1}`),
  ...extra,
});

const bom = JSON.stringify({
  graph_digest: "sha256:abc",
  lines: [
    line("b", "parts.bearing", "1", { manufacturer_part: { manufacturer: "SKF", part_number: "695-2Z" } }),
    line("a", "parts.screw", "2"),
    line("c", "parts.housing", "1", { material_process: "PRINTED" }),
    // Written before `material_process` existed: falls back to the process id.
    line("d", "parts.nut", "4", { material_process: undefined, process: { process_id: "purchased" } }),
    line("e", "parts.old-printed", "1", { material_process: undefined, process: { process_id: "printed" } }),
  ],
});

describe("parseCanonicalBom", () => {
  const lines = parseCanonicalBom(bom);

  it("keeps purchased lines in the canonical order, keyed by the BOM's own line_id", () => {
    expect(lines.map((l) => [l.key, l.definitionId, l.quantity])).toEqual([
      ["sha256:b", "parts.bearing", 1],
      ["sha256:a", "parts.screw", 2],
      ["sha256:d", "parts.nut", 4],
    ]);
  });

  it("reads manufacturer identity, instances and a parameter summary without the definition id", () => {
    expect(lines[0]).toMatchObject({ manufacturer: "SKF", partNumber: "695-2Z", parameterSummary: "length=18 · name=M3" });
    expect(lines[1]!.nodeIds).toEqual(["r/a-1", "r/a-2"]);
    expect(lines[1]!.instanceKeys).toEqual(["a-1", "a-2"]);
  });

  it("rejects a document that is not a BOM", () => {
    expect(() => parseCanonicalBom("{}")).toThrow(/not a Machinewright BOM/);
    expect(() => parseCanonicalBom("nope")).toThrow();
  });

  it("names the artifact the way the evaluation writes it", () => {
    expect(bomArtifactName("sha256:08f7589df65551d6146ec8c22ac5393f8e8cad5d4ac23d369aa43fa0ad241bca")).toBe("assembly-08f7589df655.bom.json");
  });
});

describe("procurement", () => {
  const lines = parseCanonicalBom(bom);

  it("totals order quantity, cost, unpriced lines and statuses", () => {
    let data = updateProcurement(EMPTY_PROCUREMENT_DATA, lines[1]!.key, { unitCost: 0.1, spares: 3, status: "ordered" });
    data = updateProcurement(data, lines[0]!.key, { unitCost: 2.5 });
    const totals = computeTotals(lines, data);
    expect(totals.units).toBe(1 + 5 + 4);
    expect(totals.cost).toBeCloseTo(2.5 + 0.5);
    expect(totals.unpriced).toBe(1);
    expect(totals.byStatus).toMatchObject({ ordered: 1, to_order: 2 });
    expect(extendedCost(lines[2]!, EMPTY_PROCUREMENT)).toBeNull();
  });

  it("round-trips, omits defaults, and keeps entries for parts no longer in the design", () => {
    let data = updateProcurement(EMPTY_PROCUREMENT_DATA, "sha256:gone", { supplier: "McMaster", unitCost: 1.2 });
    data = updateProcurement(data, lines[0]!.key, {});
    const back = parseProcurement(serializeProcurement({ ...data, currency: "EUR" }));
    expect(back.currency).toBe("EUR");
    expect(Object.keys(back.lines)).toEqual(["sha256:gone"]);
    expect(back.lines["sha256:gone"]).toMatchObject({ supplier: "McMaster", unitCost: 1.2 });
  });

  it("degrades to defaults on corrupt input, field by field", () => {
    for (const bad of ["", "nope", "[]", "null"]) expect(parseProcurement(bad)).toEqual(EMPTY_PROCUREMENT_DATA);
    const parsed = parseProcurement(JSON.stringify({ lines: { k: { unitCost: -3, spares: 2.9, status: "weird", supplier: 5 } } }));
    expect(parsed.lines.k).toEqual({ ...EMPTY_PROCUREMENT, spares: 2 });
  });
});

describe("procurement file format (shared with lib/procurement.py)", () => {
  it("writes the Python schema: schema_version and snake_case unit_cost", () => {
    const data = updateProcurement(EMPTY_PROCUREMENT_DATA, "sha256:a", { supplier: "McMaster", unitCost: 1.2, status: "ordered" });
    expect(JSON.parse(serializeProcurement(data))).toEqual({
      schema_version: "1.0",
      currency: "USD",
      lines: { "sha256:a": { supplier: "McMaster", sku: "", url: "", unit_cost: 1.2, spares: 0, status: "ordered", notes: "" } },
    });
  });

  it("reads files written by Python or by early app versions", () => {
    expect(parseProcurement(JSON.stringify({ lines: { k: { unit_cost: 2 } } })).lines.k?.unitCost).toBe(2);
    expect(parseProcurement(JSON.stringify({ lines: { k: { unitCost: 3 } } })).lines.k?.unitCost).toBe(3);
  });
});
