import { describe, expect, it } from "vitest";
import { buildGraphIndex } from "../../src/graph/GraphIndex";
import type { ResolvedHardwareGraph } from "../../src/model/generated/EvaluationSnapshot";
import {
  DEFAULT_PART_SETTINGS,
  DEFAULT_PRINT_SETTINGS,
  asPartExportResult,
  asPrintPlan,
  assemblyArtifactName,
  exportSettingsPath,
  exportStem,
  parseExportSettings,
  partOptionsJson,
  printOptionsJson,
  selectedPartIds,
  summarizePlan,
} from "../../src/export/exportModel";

function graph(): ResolvedHardwareGraph {
  const node = (kind: "assembly" | "part", node_id: string) => ({ kind, node_id }) as never;
  const edge = (parent: string, child: string) => ({ edge_id: `${parent}>${child}`, parent_node_id: parent, child_node_id: child }) as never;
  return {
    root_id: "root",
    nodes: [node("assembly", "root"), node("assembly", "root/gear"), node("part", "root/gear/a"), node("part", "root/gear/b"), node("part", "root/c")],
    containment: [edge("root", "root/gear"), edge("root/gear", "root/gear/a"), edge("root/gear", "root/gear/b"), edge("root", "root/c")],
  } as unknown as ResolvedHardwareGraph;
}

describe("assembly artifacts", () => {
  it("names the file the evaluation writes (first 12 hex of the digest)", () => {
    expect(assemblyArtifactName("sha256:144d49591488abcdef0123", "step")).toBe("assembly-144d49591488.step");
    expect(assemblyArtifactName("sha256:144d49591488abcdef0123", "stl")).toBe("assembly-144d49591488.stl");
  });

  it("makes safe file stems", () => {
    expect(exportStem("ironless-actuator.main")).toBe("ironless-actuator.main");
    expect(exportStem("my project/v2!")).toBe("my-project-v2");
    expect(exportStem("///")).toBe("assembly");
  });
});

describe("selectedPartIds", () => {
  const index = buildGraphIndex(graph());

  it("expands an assembly to its parts", () => {
    expect(selectedPartIds(index, ["root/gear"])).toEqual(["root/gear/a", "root/gear/b"]);
  });

  it("keeps selected parts, de-duplicates, and follows graph order", () => {
    expect(selectedPartIds(index, ["root/c", "root/gear/b", "root/gear"])).toEqual(["root/gear/a", "root/gear/b", "root/c"]);
  });

  it("ignores unknown ids and an empty selection", () => {
    expect(selectedPartIds(index, ["nope"])).toEqual([]);
    expect(selectedPartIds(index, [])).toEqual([]);
  });
});

describe("worker option documents", () => {
  it("maps part scopes onto node_ids / processes", () => {
    expect(partOptionsJson({ ...DEFAULT_PART_SETTINGS, scope: "all" }, ["x"])).toMatchObject({ node_ids: null, processes: null });
    expect(partOptionsJson({ ...DEFAULT_PART_SETTINGS, scope: "printed" }, ["x"])).toMatchObject({ node_ids: null, processes: ["PRINTED"] });
    expect(partOptionsJson({ ...DEFAULT_PART_SETTINGS, scope: "selection" }, ["x", "y"])).toMatchObject({ node_ids: ["x", "y"], processes: null });
  });

  it("uses the Python snake_case printer schema", () => {
    const options = printOptionsJson(DEFAULT_PRINT_SETTINGS, false);
    expect(options).toEqual({
      write: false,
      live: false,
      positions: {},
      printer: { name: "My printer", bed_x: 220, bed_y: 220, max_z: 250, bed_margin: 5, origin: "corner" },
      settings: { part_spacing: 6, optimize_orientation: true },
    });
  });
});

describe("printOptionsJson positions", () => {
  it("sends hand-moved parts as [x, y] pairs keyed by node id", () => {
    expect(printOptionsJson(DEFAULT_PRINT_SETTINGS, true, false, { a: { x: 10, y: 20.5 } })).toMatchObject({ positions: { a: [10, 20.5] } });
  });
});

describe("parseExportSettings", () => {
  it("falls back to defaults for empty or corrupt files", () => {
    for (const text of ["", "not json", "[]", "null", "{}"]) {
      expect(parseExportSettings(text)).toEqual({ parts: DEFAULT_PART_SETTINGS, print: DEFAULT_PRINT_SETTINGS });
    }
  });

  it("keeps valid fields and repairs invalid ones individually", () => {
    const parsed = parseExportSettings(
      JSON.stringify({
        parts: { scope: "printed", format: "bogus", combine: true },
        print: { printer: { bedX: 250, bedY: -3, origin: "center", name: "  " }, plan: { partSpacing: 2 } },
      }),
    );
    expect(parsed.parts).toEqual({ scope: "printed", format: "stl", placement: "assembly", combine: true });
    expect(parsed.print.printer).toMatchObject({ bedX: 250, bedY: 220, origin: "center", name: "My printer" });
    expect(parsed.print.plan).toEqual({ partSpacing: 2, optimizeOrientation: true });
  });

  it("stores settings inside the project's .machinewright directory", () => {
    expect(exportSettingsPath("/p/proj/")).toBe("/p/proj/.machinewright/export-settings.json");
  });
});

describe("worker results", () => {
  it("narrows plans and part results, rejecting other shapes", () => {
    const plan = { printer: "p", bed_x: 1, bed_y: 1, max_z: 1, origin: "corner", plates: [{ index: 1, material: "PLA", max_height: 3, parts: [{}, {}], stl_file: null }], skipped: [{ node_id: "n", instance_key: "k", reason: "r" }], warnings: [] };
    expect(asPrintPlan(plan)).not.toBeNull();
    expect(asPrintPlan({ files: [] })).toBeNull();
    expect(asPrintPlan(null)).toBeNull();
    expect(asPartExportResult({ files: [] })).not.toBeNull();
    expect(asPartExportResult([])).toBeNull();
    expect(summarizePlan(plan as never)).toBe("1 plate · 2 parts · 1 skipped");
  });
});
