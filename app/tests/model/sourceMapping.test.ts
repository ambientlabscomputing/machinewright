import { describe, expect, it } from "vitest";
import { resolveNodeIdsAtOffset, resolveSpanForNodeId } from "../../src/model/sourceMapping";
import type { EvaluationSnapshot, SourceMapping } from "../../src/model/generated/EvaluationSnapshot";

/**
 * A minimal fixture proving the exact R3 regression scenario: a node has
 * both a narrow call-site mapping and a broad whole-template mapping that
 * also lists it (Python emits narrow-before-broad; only `source_mappings`
 * matters for these functions, so the fixture only fills that field).
 */
function fixtureSnapshot(mappings: readonly SourceMapping[]): EvaluationSnapshot {
  return { source_mappings: mappings } as unknown as EvaluationSnapshot;
}

const CALL_SITE: SourceMapping = {
  source_id: "node:pkg/base_plate",
  node_ids: ["pkg/base_plate"],
  span: {
    path: "hardware.py",
    source_digest: "sha256:x",
    start_byte: 100,
    end_byte: 120,
    start_line: 5,
    end_line: 5,
  },
};

// One mapping covering two sibling instances at once — the R3 "done when:
// two instances from one source mapping both highlight" scenario.
const SHARED_DEFINITION: SourceMapping = {
  source_id: "definition:pkg.Pin",
  node_ids: ["pkg/pin_pair/lower_pin", "pkg/pin_pair/upper_pin"],
  span: {
    path: "hardware.py",
    source_digest: "sha256:x",
    start_byte: 200,
    end_byte: 260,
    start_line: 10,
    end_line: 15,
  },
};

const WHOLE_TEMPLATE: SourceMapping = {
  source_id: "template:pkg.simple@1.0.0",
  node_ids: ["pkg/base_plate", "pkg/pin_pair/lower_pin", "pkg/pin_pair/upper_pin"],
  span: {
    path: "hardware.py",
    source_digest: "sha256:x",
    start_byte: 0,
    end_byte: 500,
    start_line: 1,
    end_line: 30,
  },
};

// Narrowest-first, matching evaluation.py's `_source_mappings` emission order.
const snapshot = fixtureSnapshot([CALL_SITE, SHARED_DEFINITION, WHOLE_TEMPLATE]);

describe("resolveSpanForNodeId (R3 fix)", () => {
  it("returns the narrow call-site span, not the broader whole-template span", () => {
    expect(resolveSpanForNodeId(snapshot, "pkg/base_plate")).toEqual({
      path: "hardware.py",
      startByte: 100,
      endByte: 120,
    });
  });

  it("returns null for a node with no mapping at all", () => {
    expect(resolveSpanForNodeId(snapshot, "pkg/nonexistent")).toBeNull();
  });
});

describe("resolveNodeIdsAtOffset", () => {
  it("resolves an offset inside the narrow call-site span to just that node", () => {
    expect(resolveNodeIdsAtOffset(snapshot, "hardware.py", 110)).toEqual(["pkg/base_plate"]);
  });

  it("resolves an offset inside a shared definition to both sibling instances (R3 'two instances both highlight')", () => {
    expect(resolveNodeIdsAtOffset(snapshot, "hardware.py", 210)).toEqual([
      "pkg/pin_pair/lower_pin",
      "pkg/pin_pair/upper_pin",
    ]);
  });

  it("falls back to the whole-template mapping outside any narrower span", () => {
    expect(resolveNodeIdsAtOffset(snapshot, "hardware.py", 400)).toEqual(WHOLE_TEMPLATE.node_ids);
  });

  it("returns empty for a path no mapping references", () => {
    expect(resolveNodeIdsAtOffset(snapshot, "other.py", 10)).toEqual([]);
  });

  it("returns empty for an offset outside every mapping's range", () => {
    const narrowOnly = fixtureSnapshot([CALL_SITE]);
    expect(resolveNodeIdsAtOffset(narrowOnly, "hardware.py", 900)).toEqual([]);
  });
});
