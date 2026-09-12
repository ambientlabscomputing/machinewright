/**
 * Minimal JSON-RPC client for a Python language server (RFD-19 "Editor
 * architecture": "LSP diagnostics, completion, hover, navigation, symbols,
 * and code actions"; RFD line 321, "LSP client behavior" is TypeScript-
 * application-owned). This spike implements only what's needed to prove
 * the mechanism end-to-end: initialize, didOpen/didChange, and
 * publishDiagnostics — completion/hover/navigation are real follow-up
 * work, not attempted here.
 *
 * Diagnostics are converted from LSP `Position` to Machinewright's
 * byte-offset `ByteRange` (src/protocol/surfaces/editor.ts) via
 * src/editor/offsets.ts before reaching the rest of the app, so nothing
 * downstream needs to know LSP uses UTF-16 line/character positions.
 */
import { LspBridge } from "./LspBridge";
import { lspPositionToUtf8ByteOffset, type LspPosition } from "./offsets";
import type { EditorDiagnostic } from "../protocol/surfaces/editor";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface LspDiagnosticPayload {
  range: { start: LspPosition; end: LspPosition };
  message: string;
  severity?: 1 | 2 | 3 | 4; // LSP: Error=1, Warning=2, Information=3, Hint=4
}

function severityToEditorSeverity(severity: number | undefined): EditorDiagnostic["severity"] {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  return "info";
}

export class LspClient {
  private readonly bridge = new LspBridge();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly openDocuments = new Map<string, { text: string; version: number }>();
  private unsubscribeMessage: (() => void) | null = null;

  onDiagnostics: ((uri: string, diagnostics: readonly EditorDiagnostic[]) => void) | null = null;

  async start(executablePath: string, rootUri: string): Promise<void> {
    this.unsubscribeMessage = this.bridge.onMessage((message) => this.handleMessage(message));
    await this.bridge.spawn(executablePath, []);
    await this.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: {},
        },
      },
    });
    await this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    await this.bridge.stop();
  }

  async didOpen(uri: string, languageId: string, text: string): Promise<void> {
    this.openDocuments.set(uri, { text, version: 1 });
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async didChange(uri: string, text: string): Promise<void> {
    const existing = this.openDocuments.get(uri);
    const version = (existing?.version ?? 0) + 1;
    this.openDocuments.set(uri, { text, version });
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }], // whole-document sync — simplest correct option for a spike
    });
  }

  private handleMessage(message: unknown): void {
    const parsed = message as Partial<JsonRpcResponse & JsonRpcRequest>;
    if (typeof parsed.id === "number" && (parsed.result !== undefined || parsed.error)) {
      const waiter = this.pending.get(parsed.id);
      if (!waiter) return;
      this.pending.delete(parsed.id);
      if (parsed.error) waiter.reject(new Error(parsed.error.message));
      else waiter.resolve(parsed.result);
      return;
    }
    if (parsed.method === "textDocument/publishDiagnostics") {
      const params = parsed.params as { uri: string; diagnostics: LspDiagnosticPayload[] };
      const document = this.openDocuments.get(params.uri);
      if (!document) return;
      const diagnostics = params.diagnostics.map(
        (diagnostic): EditorDiagnostic => ({
          source: "lsp",
          severity: severityToEditorSeverity(diagnostic.severity),
          message: diagnostic.message,
          range: {
            startByte: lspPositionToUtf8ByteOffset(document.text, diagnostic.range.start),
            endByte: lspPositionToUtf8ByteOffset(document.text, diagnostic.range.end),
          },
        }),
      );
      this.onDiagnostics?.(params.uri, diagnostics);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.bridge.send(payload);
    });
  }

  private notify(method: string, params: unknown): Promise<void> {
    const payload: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    return this.bridge.send(payload);
  }
}
