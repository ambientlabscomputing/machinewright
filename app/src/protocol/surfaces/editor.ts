/**
 * Versioned messages between the RN/TS application shell and the bundled
 * CodeMirror 6 WebView surface (RFD-19 "Editor architecture" section).
 *
 * This is deliberately a *separate* schema from the worker protocol
 * (../worker) — it carries editor-transaction and selection traffic between
 * the application store and a WebView, never Python evaluation traffic.
 *
 * `documentVersion` is intentionally a distinct identity axis from an
 * evaluation `generation`: a single evaluation generation can span zero or
 * many document-version bumps (unsaved keystrokes), and a document version
 * can advance without ever triggering a new evaluation (e.g. a comment
 * edit). Conflating the two was part of what made the deleted Rust UI's
 * invalidation logic hard to reason about (see the M2 implementation
 * review, finding R2: undo/redo/reload used the same suppression flag as
 * ordinary typing instead of a semantic "did the authoritative source
 * change" signal).
 */

import type { LspPosition } from "../../editor/offsets";

export type DocumentVersion = number;

export type LanguageQuery = "completion" | "hover" | "definition";
export type LanguageResult =
  | { readonly kind: "completion"; readonly options: readonly { label: string; insertText?: string; detail?: string }[] }
  | { readonly kind: "hover"; readonly text: string }
  | { readonly kind: "definition"; readonly uri: string; readonly position: LspPosition }
  | null;

export interface DocumentIdentity {
  /** Project-relative path, POSIX-separated, matching SourceSpan.path. */
  readonly path: string;
  readonly documentVersion: DocumentVersion;
}

export interface ByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

/** Commands the application shell sends into the editor WebView. */
export type EditorHostCommand =
  | {
      readonly kind: "loadDocument";
      readonly path: string;
      readonly content: string;
      readonly documentVersion: DocumentVersion;
      readonly readOnly: boolean;
    }
  | {
      readonly kind: "applyExternalEdit";
      readonly path: string;
      readonly content: string;
      readonly documentVersion: DocumentVersion;
      readonly reason: "disk_reload" | "undo" | "redo";
    }
  | {
      readonly kind: "setSelection";
      readonly path: string;
      readonly range: ByteRange;
    }
  | {
      readonly kind: "setDiagnostics";
      readonly path: string;
      readonly documentVersion: DocumentVersion;
      readonly diagnostics: readonly EditorDiagnostic[];
    }
  | { readonly kind: "closeDocument"; readonly path: string }
  /** Opens the in-file find panel (Cmd+F), seeded with the current selection if any. */
  | { readonly kind: "openFind" }
  /** Gives the editor surface DOM focus (the shell separately makes the WebView first responder). */
  | { readonly kind: "focus" }
  | { readonly kind: "languageResult"; readonly id: number; readonly result: LanguageResult };

/** Events the editor WebView emits back to the application shell. */
export type EditorSurfaceEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "saveRequested"; readonly path: string }
  | {
      readonly kind: "languageQuery";
      readonly id: number;
      readonly path: string;
      readonly documentVersion: DocumentVersion;
      readonly query: LanguageQuery;
      readonly position: LspPosition;
    }
  | {
      readonly kind: "documentChanged";
      readonly path: string;
      readonly documentVersion: DocumentVersion;
      readonly content: string;
      /**
       * Why the authoritative source changed. Typing and paste are the only
       * origins that should feed the evaluation debounce; undo/redo/reload
       * are also semantic source changes (must invalidate) but are surfaced
       * distinctly so a host can, e.g., skip re-fitting a cursor it just
       * set programmatically. This event fires for all of them — the R2
       * fix is that the host derives invalidation from this event existing
       * at all, never from tracking "was this edit programmatic."
       */
      readonly origin: "typing" | "paste" | "undo" | "redo" | "reload";
    }
  | {
      readonly kind: "selectionChanged";
      readonly path: string;
      readonly documentVersion: DocumentVersion;
      readonly range: ByteRange;
    }
  | { readonly kind: "documentClosed"; readonly path: string };

export interface EditorDiagnostic {
  readonly source: "lsp" | "evaluation";
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly range: ByteRange;
  /** Present for `source: "evaluation"`; joins back to Diagnostic.code. */
  readonly code?: string;
}
