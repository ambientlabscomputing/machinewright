/**
 * Contract test: parses a real `.mwm2` file produced by the actual Python
 * CLI (not just the hand-encoded buffer in mwm.test.ts), proving
 * web/viewport/src/mwm.ts's understanding of the format matches what
 * evaluation.py's `_write_meshes` actually emits, byte for byte.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMwm } from "../../web/viewport/src/mwm";

const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const repoRoot = path.dirname(appRoot);

describe("parseMwm against a real evaluation", () => {
  it(
    "matches the MeshReference metadata the CLI reports",
    () => {
      const outputDirectory = mkdtempSync(path.join(tmpdir(), "mw-app-mwm-test-"));
      execFileSync(
        path.join(repoRoot, ".venv", "bin", "machinewright"),
        [
          "project",
          "evaluate",
          "machinewright.reference.simple",
          "1.0.0",
          "examples/inputs/reference.json",
          outputDirectory,
        ],
        { cwd: repoRoot },
      );

      const snapshot = JSON.parse(
        readFileSync(path.join(outputDirectory, "evaluation-snapshot.json"), "utf-8"),
      ) as { meshes: { name: string; vertex_count: number; triangle_count: number; bounds: string[] }[] };
      expect(snapshot.meshes.length).toBeGreaterThan(0);

      for (const mesh of snapshot.meshes) {
        const buffer = readFileSync(path.join(outputDirectory, mesh.name));
        const parsed = parseMwm(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
        expect(parsed.positions.length).toBe(mesh.vertex_count * 3);
        expect(parsed.indices.length).toBe(mesh.triangle_count * 3);
        const expectedBounds = mesh.bounds.map(Number);
        for (let i = 0; i < 6; i++) {
          expect(parsed.bounds[i]).toBeCloseTo(expectedBounds[i]!, 3);
        }
      }
    },
    30_000,
  );
});
