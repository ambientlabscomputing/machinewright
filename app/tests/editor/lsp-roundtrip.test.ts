/**
 * Contract test proving the bundled Python language server (pylsp) speaks
 * the LSP base protocol the way src/editor/LspClient.ts and the native
 * MachinewrightLspModule assume: Content-Length framing, an `initialize`
 * response, and `textDocument/publishDiagnostics` after `didOpen` on a
 * file with a real error (undefined name) — proving diagnostics actually
 * flow, not just that the process starts.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeLspFrame, LspFrameDecoder } from "../../src/editor/lspFraming";

const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const repoRoot = path.dirname(appRoot);
const pylspBin = path.join(repoRoot, ".venv", "bin", "pylsp");

interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  params?: unknown;
}

function launchPylsp() {
  const child = spawn(pylspBin, [], { stdio: ["pipe", "pipe", "inherit"] });
  const decoder = new LspFrameDecoder();
  const pending: JsonRpcMessage[] = [];
  const waiters: ((message: JsonRpcMessage) => void)[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(message as JsonRpcMessage);
      else pending.push(message as JsonRpcMessage);
    }
  });

  function nextMessage(): Promise<JsonRpcMessage> {
    const buffered = pending.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => waiters.push(resolve));
  }

  function send(message: unknown) {
    child.stdin.write(encodeLspFrame(message));
  }

  return { child, send, nextMessage };
}

describe("pylsp wire protocol round-trip", () => {
  it(
    "diagnoses an open document and completes a symbol in its unsaved buffer",
    async () => {
      const { child, send, nextMessage } = launchPylsp();
      try {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { processId: null, rootUri: `file://${repoRoot}`, capabilities: {} },
        });
        let initializeResponse = await nextMessage();
        while (initializeResponse.id !== 1) {
          initializeResponse = await nextMessage();
        }
        expect(initializeResponse.result).toBeDefined();

        send({ jsonrpc: "2.0", method: "initialized", params: {} });

        // Written to disk, not just sent as didOpen text: some pylsp
        // plugins resolve documents against the actual filesystem path,
        // not only the in-memory buffer.
        const documentPath = "/tmp/machinewright-lsp-contract-test.py";
        const uri = `file://${documentPath}`;
        // `undefined_name` is never assigned — pyflakes (bundled with
        // pylsp) must report it as a real diagnostic.
        writeFileSync(documentPath, "print(undefined_name)\n");
        send({
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: { uri, languageId: "python", version: 1, text: "print(undefined_name)\n" },
          },
        });

        // pylsp publishes an initial empty diagnostics set immediately,
        // then a follow-up once pyflakes/pycodestyle actually finish
        // linting — publishDiagnostics replaces (not accumulates) the
        // previous set for a URI, so keep consuming until a non-empty one
        // arrives (bounded by this test's own timeout).
        let params: { uri: string; diagnostics: unknown[] };
        do {
          let diagnosticsMessage = await nextMessage();
          while (diagnosticsMessage.method !== "textDocument/publishDiagnostics") {
            diagnosticsMessage = await nextMessage();
          }
          params = diagnosticsMessage.params as { uri: string; diagnostics: unknown[] };
        } while (params.diagnostics.length === 0);
        expect(params.uri).toBe(uri);
        expect(params.diagnostics.length).toBeGreaterThan(0);

        send({
          jsonrpc: "2.0",
          method: "textDocument/didChange",
          params: {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: "plate_width = 40\nplate_w" }],
          },
        });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "textDocument/completion",
          params: { textDocument: { uri }, position: { line: 1, character: 7 } },
        });
        let completion = await nextMessage();
        while (completion.id !== 2) completion = await nextMessage();
        const result = completion.result as { items: { label: string }[] };
        expect(result.items.some(({ label }) => label === "plate_width")).toBe(true);
      } finally {
        child.kill();
      }
    },
    30_000,
  );
});
