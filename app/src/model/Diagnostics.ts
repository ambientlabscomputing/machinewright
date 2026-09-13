/**
 * Normalizes evaluation-origin and LSP-origin diagnostics into one
 * structured list — the fix for the deleted Rust UI's review finding R9:
 * "structured evaluation diagnostics are discarded at the [process]
 * boundary... The adapter displays the failure string." `code`/`severity`/
 * `source_path`/`context` must survive end-to-end into a "Problems" panel;
 * `EvaluationFailed.message`/`traceback` are retained as a distinct
 * fallback field, never the sole representation of a failure.
 */
import type { Diagnostic as EvaluationDiagnostic } from "./generated/EvaluationSnapshot";
import type { EditorDiagnostic } from "../protocol/surfaces/editor";
import type { EvaluationFailure } from "../evaluator/EvaluationCoordinator";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface StructuredDiagnostic {
  readonly origin: "evaluation" | "lsp" | "evaluation_failure";
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Present for evaluation-origin diagnostics; joins back to Diagnostic.code. */
  readonly code?: string;
  readonly sourcePath?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly range?: { readonly startByte: number; readonly endByte: number };
  /** Present only for `origin: "evaluation_failure"` — the last-resort fallback row. */
  readonly traceback?: string;
}

export function fromEvaluationDiagnostics(
  diagnostics: readonly EvaluationDiagnostic[],
): readonly StructuredDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    origin: "evaluation",
    severity: diagnostic.severity,
    message: diagnostic.message,
    code: diagnostic.code,
    sourcePath: diagnostic.source_path,
    context: diagnostic.context,
  }));
}

export function fromEditorDiagnostics(
  diagnostics: readonly EditorDiagnostic[],
  path: string,
): readonly StructuredDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    origin: "lsp",
    severity: diagnostic.severity,
    message: diagnostic.message,
    sourcePath: path,
    range: diagnostic.range,
  }));
}

/**
 * The last-resort fallback row for an `EvaluationFailed` event whose
 * `diagnosticsJson` was empty (e.g. an unhandled Python exception rather
 * than a structured validation failure). This must never be the *only*
 * form structured diagnostics take when `diagnosticsJson` did carry
 * content — call `fromEvaluationDiagnostics` on that JSON's parsed
 * `Diagnostic[]` first, and use this only as a supplement/fallback.
 */
export function fromEvaluationFailure(failure: EvaluationFailure): StructuredDiagnostic {
  return {
    origin: "evaluation_failure",
    severity: "error",
    message: failure.message,
    code: failure.code,
    traceback: failure.traceback,
  };
}

/** Merges diagnostic groups from multiple origins into one flat list. */
export function mergeDiagnostics(
  ...groups: ReadonlyArray<readonly StructuredDiagnostic[]>
): readonly StructuredDiagnostic[] {
  return groups.flat();
}
