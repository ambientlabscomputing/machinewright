/**
 * Guards the one real coupling of the BOM tab: the file Machinewright's Python
 * evaluation writes. Evaluates the reference project with the real CLI and parses
 * the resulting `bom.json`, so a Python-side change to the BOM shape fails here
 * instead of silently emptying the tab.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bomArtifactName, parseCanonicalBom } from "../../src/bom/bomModel";

const repoRoot = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

describe("canonical bom.json from a real evaluation", () => {
  it("parses, and the artifact name the app derives matches the file written", () => {
    const out = mkdtempSync(path.join(tmpdir(), "mw-bom-"));
    execFileSync(
      path.join(repoRoot, ".venv", "bin", "machinewright"),
      ["project", "evaluate", "machinewright.reference.simple", "1.0.0", path.join(repoRoot, "examples", "inputs", "reference.json"), out],
      { cwd: repoRoot, stdio: "pipe" },
    );
    const written = readdirSync(out).find((name) => name.endsWith(".bom.json"));
    expect(written).toBeDefined();
    const text = readFileSync(path.join(out, written!), "utf8");
    const digest = (JSON.parse(text) as { graph_digest: string }).graph_digest;
    expect(bomArtifactName(digest)).toBe(written);
    const raw = JSON.parse(text) as { lines: { material_process?: string; quantity: string }[] };
    expect(raw.lines.length).toBeGreaterThan(0);
    expect(raw.lines.every((l) => "material_process" in l)).toBe(true); // the Python field this tab relies on
    const purchased = raw.lines.filter((l) => l.material_process === "PURCHASED").length;
    expect(parseCanonicalBom(text)).toHaveLength(purchased);
  }, 60_000);
});
