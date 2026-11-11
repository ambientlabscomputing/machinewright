/**
 * B.3 spike: CodeMirror 6 bundled WebView surface (RFD-19 "Editor
 * architecture" / architecture-spike steps 2, 3). Wired to the
 * app/src/protocol/surfaces/editor.ts contract — the same versioned
 * message shapes the RN host (src/editor/EditorHost.tsx) sends/receives.
 *
 * Byte <-> CodeMirror-position conversion reuses src/editor/offsets.ts
 * (CodeMirror positions are UTF-16 JS string indices, same coordinate
 * system that module's "string index" side already targets) rather than
 * duplicating that logic here.
 */
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { setDiagnostics as cmSetDiagnostics, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { utf8ByteOffsetToStringIndex, stringIndexToUtf8ByteOffset, stringIndexToLspPosition } from "../../../src/editor/offsets";
import type { EditorHostCommand, EditorSurfaceEvent, LanguageQuery, LanguageResult } from "../../../src/protocol/surfaces/editor";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(event: EditorSurfaceEvent): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(event));
}

let currentPath: string | null = null;
let currentDocumentVersion = 0;
let suppressChangeEvent = false;

type DocumentChangedOrigin = Extract<EditorSurfaceEvent, { kind: "documentChanged" }>["origin"];

function originFromTransaction(tr: { isUserEvent: (kind: string) => boolean }): DocumentChangedOrigin {
  if (tr.isUserEvent("undo")) return "undo";
  if (tr.isUserEvent("redo")) return "redo";
  if (tr.isUserEvent("input.paste")) return "paste";
  return "typing";
}

function onUpdate(update: ViewUpdate): void {
  if (update.docChanged && !suppressChangeEvent && currentPath) {
    currentDocumentVersion += 1;
    post({
      kind: "documentChanged",
      path: currentPath,
      documentVersion: currentDocumentVersion,
      content: update.state.doc.toString(),
      origin: originFromTransaction(update.transactions[0] ?? { isUserEvent: () => false }),
    });
  }
  if (update.selectionSet && currentPath) {
    const range = update.state.selection.main;
    const text = update.state.doc.toString();
    post({
      kind: "selectionChanged",
      path: currentPath,
      documentVersion: currentDocumentVersion,
      range: {
        startByte: stringIndexToUtf8ByteOffset(text, range.from),
        endByte: stringIndexToUtf8ByteOffset(text, range.to),
      },
    });
  }
}

let nextQueryId = 0;
const queries = new Map<number, (result: LanguageResult) => void>();

function queryLanguage(query: LanguageQuery, offset: number): Promise<LanguageResult> {
  if (!currentPath) return Promise.resolve(null);
  const id = ++nextQueryId;
  const path = currentPath;
  const documentVersion = currentDocumentVersion;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      queries.delete(id);
      resolve(null);
    }, 6000);
    queries.set(id, (result) => {
      clearTimeout(timeout);
      resolve(path === currentPath && documentVersion === currentDocumentVersion ? result : null);
    });
    post({
      kind: "languageQuery", id, path, documentVersion, query,
      position: stringIndexToLspPosition(view.state.doc.toString(), offset),
    });
  });
}

async function pythonCompletion(context: CompletionContext) {
  const word = context.matchBefore(/[\p{L}\p{N}_]+/u);
  if (!word && !context.explicit && context.state.sliceDoc(context.pos - 1, context.pos) !== ".") return null;
  const result = await queryLanguage("completion", context.pos);
  if (result?.kind !== "completion" || context.aborted || !result.options.length) return null;
  return {
    from: word?.from ?? context.pos,
    options: result.options.map(({ label, detail, insertText }) => ({ label, detail, apply: insertText })),
  };
}

const pythonHover = hoverTooltip(async (_view, pos) => {
  const result = await queryLanguage("hover", pos);
  if (result?.kind !== "hover" || !result.text.trim()) return null;
  return {
    pos,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "python-hover";
      dom.textContent = result.text;
      return { dom };
    },
  };
});

function buildExtensions(readOnly: boolean, path = "") {
  const isPython = /\.pyi?$/.test(path);
  return [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    keymap.of([
      { key: "Mod-s", run: () => {
        if (currentPath) post({ kind: "saveRequested", path: currentPath });
        return true;
      } },
      ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab,
    ]),
    lintGutter(),
    EditorState.readOnly.of(readOnly),
    EditorView.updateListener.of(onUpdate),
    ...(isPython ? [
      python(),
      syntaxHighlighting(defaultHighlightStyle),
      indentUnit.of("    "),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      autocompletion(),
      pythonLanguage.data.of({ autocomplete: pythonCompletion }),
      pythonHover,
      keymap.of([{ key: "F12", run: (editor) => {
        void queryLanguage("definition", editor.state.selection.main.head);
        return true;
      } }]),
    ] : []),
  ];
}

const view = new EditorView({
  parent: document.body,
  state: EditorState.create({ doc: "", extensions: buildExtensions(false) }),
});

function handleCommand(command: EditorHostCommand): void {
  switch (command.kind) {
    case "loadDocument": {
      currentPath = command.path;
      currentDocumentVersion = command.documentVersion;
      suppressChangeEvent = true;
      view.setState(
        EditorState.create({ doc: command.content, extensions: buildExtensions(command.readOnly, command.path) }),
      );
      suppressChangeEvent = false;
      break;
    }
    case "applyExternalEdit": {
      if (command.path !== currentPath) break;
      suppressChangeEvent = true;
      currentDocumentVersion = command.documentVersion;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: command.content },
      });
      suppressChangeEvent = false;
      break;
    }
    case "setSelection": {
      if (command.path !== currentPath) break;
      const text = view.state.doc.toString();
      const anchor = utf8ByteOffsetToStringIndex(text, command.range.startByte);
      const head = utf8ByteOffsetToStringIndex(text, command.range.endByte);
      view.dispatch({
        selection: { anchor, head },
        // Setting the selection alone moves the cursor but does not
        // scroll it into view — "select a component in 3D and see its
        // defining code" (RFD-19) needs the navigation to be visible.
        effects: EditorView.scrollIntoView(anchor, { y: "center" }),
      });
      break;
    }
    case "setDiagnostics": {
      if (command.path !== currentPath || command.documentVersion !== currentDocumentVersion) break;
      const text = view.state.doc.toString();
      const cmDiagnostics: CmDiagnostic[] = command.diagnostics.map((diagnostic) => ({
        from: utf8ByteOffsetToStringIndex(text, diagnostic.range.startByte),
        to: utf8ByteOffsetToStringIndex(text, diagnostic.range.endByte),
        severity: diagnostic.severity === "info" ? "info" : diagnostic.severity,
        message: diagnostic.message,
      }));
      view.dispatch(cmSetDiagnostics(view.state, cmDiagnostics));
      break;
    }
    case "languageResult": {
      queries.get(command.id)?.(command.result);
      queries.delete(command.id);
      break;
    }
    case "closeDocument": {
      currentPath = null;
      break;
    }
  }
}

window.addEventListener("message", (event: MessageEvent<string>) => {
  handleCommand(JSON.parse(event.data) as EditorHostCommand);
});

post({ kind: "ready" });
