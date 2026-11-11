/** JSON-RPC client for the project-local Python language server. */
import { LspBridge } from "./LspBridge";
import { lspPositionToUtf8ByteOffset, type LspPosition } from "./offsets";
import type { EditorDiagnostic, LanguageQuery, LanguageResult } from "../protocol/surfaces/editor";

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

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class LspClient {
  private readonly bridge = new LspBridge();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly openDocuments = new Map<string, { text: string; version: number }>();
  private unsubscribeExit: (() => void) | null = null;
  private unsubscribeMessage: (() => void) | null = null;

  onDiagnostics: ((uri: string, text: string, diagnostics: readonly EditorDiagnostic[]) => void) | null = null;
  onExit: (() => void) | null = null;

  constructor(options: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async start(executablePath: string, rootUri: string): Promise<void> {
    this.unsubscribeMessage = this.bridge.onMessage((message) => this.handleMessage(message));
    this.unsubscribeExit = this.bridge.onExit(() => {
      this.rejectPending();
      this.onExit?.();
    });
    await this.bridge.spawn(executablePath, []);
    await this.request("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ["plaintext", "markdown"] },
          publishDiagnostics: {},
        },
      },
    });
    await this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    this.unsubscribeExit?.();
    this.unsubscribeExit = null;
    this.rejectPending();
    this.openDocuments.clear();
    await this.bridge.stop();
  }

  async didOpen(uri: string, languageId: string, text: string): Promise<void> {
    const existing = this.openDocuments.get(uri);
    if (existing) {
      if (existing.text !== text) await this.didChange(uri, text);
      return;
    }
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

  async query(uri: string, query: LanguageQuery, position: LspPosition): Promise<LanguageResult> {
    const params = { textDocument: { uri }, position };
    if (query === "completion") {
      type Item = { label: string; insertText?: string; detail?: string };
      const response = await this.request("textDocument/completion", params) as
        | Item[] | { items: Item[] } | null;
      const items = Array.isArray(response) ? response : response?.items ?? [];
      return {
        kind: "completion",
        options: items.slice(0, 200).map(({ label, insertText, detail }) => ({ label, insertText, detail })),
      };
    }
    if (query === "hover") {
      type Markup = string | { value: string };
      const response = await this.request("textDocument/hover", params) as { contents: Markup | Markup[] } | null;
      const contents = response?.contents ?? [];
      const text = (Array.isArray(contents) ? contents : [contents])
        .map((item) => typeof item === "string" ? item : item.value).join("\n\n");
      return { kind: "hover", text };
    }
    type Location = { uri: string; range: { start: LspPosition } };
    const response = await this.request("textDocument/definition", params) as Location | Location[] | null;
    const location = Array.isArray(response) ? response[0] : response;
    return location ? { kind: "definition", uri: location.uri, position: location.range.start } : null;
  }

  private rejectPending(): void {
    for (const waiter of this.pending.values()) waiter.reject(new Error("Python language server stopped"));
    this.pending.clear();
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
      const params = parsed.params as { uri: string; version?: number; diagnostics: LspDiagnosticPayload[] };
      const document = this.openDocuments.get(params.uri);
      if (!document || (params.version !== undefined && params.version !== document.version)) return;
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
      this.onDiagnostics?.(params.uri, document.text, diagnostics);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 32) return Promise.reject(new Error("Too many pending Python language requests"));
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `LSP request '${method}' (id ${id}) timed out after ${this.requestTimeoutMs}ms — server appears unresponsive`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      void this.bridge.send(payload).catch((error: unknown) => {
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending.delete(id);
      });
    });
  }

  private notify(method: string, params: unknown): Promise<void> {
    const payload: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    return this.bridge.send(payload);
  }
}
