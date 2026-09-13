/**
 * Versioned open-document state for a project workspace (RFD-19: "Workspace
 * and versioned source-buffer state").
 *
 * This is the concrete fix for the deleted Rust UI's review finding R2:
 * "undo, redo, and disk reload bypass reevaluation" — the old adapter used
 * a single `programmatic_edit` suppression flag for both display rebinding
 * (switching which tab is visible — must NOT reevaluate) and genuine
 * authoritative source changes coming from undo/redo/external reload (MUST
 * reevaluate like any other edit).
 *
 * `applyChange` is the *only* method that advances a document's version,
 * marks it dirty, and notifies listeners — and it treats every origin
 * (`typing`/`paste`/`undo`/`redo`/`reload`) identically. Tab-switching code
 * never calls it, so display rebinding is structurally incapable of
 * reaching the evaluation trigger; there is no flag to get out of sync.
 */

export type DocumentChangeOrigin = "typing" | "paste" | "undo" | "redo" | "reload";

export interface OpenDocument {
  /** Project-relative, POSIX-separated path — matches SourceSpan.path. */
  readonly path: string;
  readonly documentVersion: number;
  readonly savedContent: string;
  readonly bufferContent: string;
  readonly dirty: boolean;
}

export interface DocumentChangeEvent {
  readonly document: OpenDocument;
  readonly origin: DocumentChangeOrigin;
}

export interface SourceOverlayInput {
  readonly relativePath: string;
  readonly content: Uint8Array;
}

export interface DocumentStoreOptions {
  readonly readFile: (path: string) => Promise<string>;
}

const encoder = new TextEncoder();

export class DocumentStore {
  private readonly readFile: (path: string) => Promise<string>;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly listeners = new Set<(event: DocumentChangeEvent) => void>();

  constructor(options: DocumentStoreOptions) {
    this.readFile = options.readFile;
  }

  /** Opens (or returns the already-open) document at `path`. */
  async open(path: string): Promise<OpenDocument> {
    const existing = this.documents.get(path);
    if (existing) return existing;
    const content = await this.readFile(path);
    const document: OpenDocument = {
      path,
      documentVersion: 0,
      savedContent: content,
      bufferContent: content,
      dirty: false,
    };
    this.documents.set(path, document);
    return document;
  }

  get(path: string): OpenDocument | undefined {
    return this.documents.get(path);
  }

  /** Every currently open document, for a caller (e.g. `app/AppShell.tsx`) that needs to refresh its own display list after a change. */
  listOpen(): readonly OpenDocument[] {
    return [...this.documents.values()];
  }

  /**
   * Records an authoritative content change, regardless of its origin.
   * This is the single call site the R2 fix depends on: every origin bumps
   * `documentVersion`, marks the document dirty (relative to its last save),
   * and notifies subscribers identically. There is deliberately no
   * "programmatic vs. user" distinction here — that distinction belongs to
   * *why* content changed, which every origin here already captures.
   */
  applyChange(path: string, content: string, origin: DocumentChangeOrigin): OpenDocument {
    const previous = this.documents.get(path);
    const next: OpenDocument = {
      path,
      documentVersion: (previous?.documentVersion ?? 0) + 1,
      savedContent: previous?.savedContent ?? content,
      bufferContent: content,
      dirty: content !== (previous?.savedContent ?? content),
    };
    this.documents.set(path, next);
    this.notify({ document: next, origin });
    return next;
  }

  /**
   * Marks the current buffer as saved to disk. This does not itself change
   * `bufferContent` and is not a document-change origin — the buffer's
   * *content* hasn't changed, only its saved/dirty status has — so this
   * never notifies (no reevaluation is triggered just by saving).
   */
  markSaved(path: string): void {
    const existing = this.documents.get(path);
    if (!existing) return;
    this.documents.set(path, { ...existing, savedContent: existing.bufferContent, dirty: false });
  }

  close(path: string): void {
    this.documents.delete(path);
  }

  /** Every dirty open document, as worker `SourceOverlay` inputs. */
  overlaysForEvaluation(): readonly SourceOverlayInput[] {
    const overlays: SourceOverlayInput[] = [];
    for (const document of this.documents.values()) {
      if (!document.dirty) continue;
      overlays.push({ relativePath: document.path, content: encoder.encode(document.bufferContent) });
    }
    return overlays;
  }

  onChange(listener: (event: DocumentChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: DocumentChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
