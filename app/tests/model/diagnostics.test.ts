/**
 * R9 regression: structured fields (code/severity/source_path/context for
 * evaluation diagnostics; range for LSP diagnostics) must survive the
 * normalization into `StructuredDiagnostic` — never collapsed into a single
 * message string.
 */
import { describe, expect, it } from "vitest";
import {
  fromEditorDiagnostics,
  fromEvaluationDiagnostics,
  fromEvaluationFailure,
  mergeDiagnostics,
} from "../../src/model/Diagnostics";
import type { Diagnostic } from "../../src/model/generated/EvaluationSnapshot";
import type { EditorDiagnostic } from "../../src/protocol/surfaces/editor";

describe("Diagnostics normalization", () => {
  it("R9: preserves code, severity, source_path, and context from evaluation diagnostics", () => {
    const raw: Diagnostic[] = [
      {
        code: "MW-COMPAT-003",
        message: "bore diameter exceeds shaft tolerance",
        severity: "error",
        source_path: "gantry.py",
        context: { node_id: "n42", expected_mm: 8.0, actual_mm: 8.4 },
      },
    ];

    const [structured] = fromEvaluationDiagnostics(raw);

    expect(structured).toMatchObject({
      origin: "evaluation",
      severity: "error",
      code: "MW-COMPAT-003",
      sourcePath: "gantry.py",
      message: "bore diameter exceeds shaft tolerance",
      context: { node_id: "n42", expected_mm: 8.0, actual_mm: 8.4 },
    });
  });

  it("preserves byte range and severity from LSP diagnostics, tagged with their source path", () => {
    const raw: EditorDiagnostic[] = [
      {
        source: "lsp",
        severity: "warning",
        message: "unused import",
        range: { startByte: 0, endByte: 12 },
      },
    ];

    const [structured] = fromEditorDiagnostics(raw, "motion_core.py");

    expect(structured).toMatchObject({
      origin: "lsp",
      severity: "warning",
      sourcePath: "motion_core.py",
      range: { startByte: 0, endByte: 12 },
    });
  });

  it("R9: an EvaluationFailed fallback row keeps code/message/traceback distinct, never merged into one string", () => {
    const fallback = fromEvaluationFailure({
      generation: 1n,
      code: "unhandled_exception",
      message: "ZeroDivisionError: division by zero",
      traceback: "Traceback (most recent call last):\n  ...",
      diagnosticsJson: new Uint8Array(0),
    });

    expect(fallback.origin).toBe("evaluation_failure");
    expect(fallback.code).toBe("unhandled_exception");
    expect(fallback.message).toBe("ZeroDivisionError: division by zero");
    expect(fallback.traceback).toContain("Traceback");
  });

  it("mergeDiagnostics concatenates groups from multiple origins without dropping any", () => {
    const evaluationDiagnostics = fromEvaluationDiagnostics([
      { code: "MW-001", message: "a", severity: "info" },
    ]);
    const lspDiagnostics = fromEditorDiagnostics(
      [{ source: "lsp", severity: "error", message: "b", range: { startByte: 0, endByte: 1 } }],
      "x.py",
    );

    const merged = mergeDiagnostics(evaluationDiagnostics, lspDiagnostics);
    expect(merged).toHaveLength(2);
    expect(merged.map((d) => d.origin)).toEqual(["evaluation", "lsp"]);
  });
});
