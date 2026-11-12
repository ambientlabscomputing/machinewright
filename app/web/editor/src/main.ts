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
import { tags } from "@lezer/highlight";
import { EditorView, keymap, lineNumbers, highlightActiveLine, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { bracketMatching, HighlightStyle, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { python, pythonLanguage } from "@codemirror/lang-python";
import { setDiagnostics as cmSetDiagnostics, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { utf8ByteOffsetToStringIndex, stringIndexToUtf8ByteOffset, stringIndexToLspPosition } from "../../../src/editor/offsets";
import theme from "../../design-system/generated/viewport-theme.json";
import type { EditorHostCommand, EditorSurfaceEvent, LanguageQuery, LanguageResult } from "../../../src/protocol/surfaces/editor";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

// --- Theme (design tokens only; see src/design-system/tokens/colors.ts) ----

const c = {
  workspace: theme["color-surface-workspace"],
  panel: theme["color-surface-panel"],
  control: theme["color-surface-control"],
  text: theme["color-text-primary"],
  muted: theme["color-text-secondary"],
  border: theme["color-border-subtle"],
  copper: theme["color-accent-action"],
  blue: theme["color-accent-selection"],
  green: theme["color-status-success"],
  yellow: theme["color-status-warning"],
  red: theme["color-status-error"],
};

const editorTheme = EditorView.theme(
  {
    "&": { backgroundColor: c.panel, color: c.text, height: "100%" },
    ".cm-content": { caretColor: c.blue },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.blue },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { backgroundColor: c.panel },
    ".cm-gutters": { backgroundColor: c.panel, color: c.muted, border: "none", borderRight: `1px solid ${c.border}` },
    ".cm-activeLine": { backgroundColor: `${c.control}99` },
    ".cm-activeLineGutter": { backgroundColor: `${c.control}99`, color: c.text },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: `${c.blue}40` },
    ".cm-selectionMatch": { backgroundColor: `${c.yellow}30` },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: `${c.blue}30`, outline: `1px solid ${c.blue}80` },
    "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: `${c.red}30` },
    ".cm-foldPlaceholder": { backgroundColor: c.control, border: `1px solid ${c.border}`, color: c.muted },
    ".cm-tooltip": { backgroundColor: c.control, color: c.text, border: `1px solid ${c.border}`, borderRadius: "4px" },
    ".cm-tooltip .cm-tooltip-arrow:before, .cm-tooltip .cm-tooltip-arrow:after": { borderTopColor: "transparent", borderBottomColor: "transparent" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: `${c.blue}30`, color: c.text },
    ".cm-completionDetail": { color: c.muted },
    ".cm-completionMatchedText": { color: c.copper, textDecoration: "none" },
    ".cm-tooltip.cm-tooltip-lint": { backgroundColor: c.control },
    ".cm-diagnostic": { borderLeft: `3px solid ${c.blue}` },
    ".cm-diagnostic-error": { borderLeftColor: c.red },
    ".cm-diagnostic-warning": { borderLeftColor: c.yellow },
    ".cm-diagnostic-info": { borderLeftColor: c.blue },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: `underline wavy ${c.red}` },
    ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: `underline wavy ${c.yellow}` },
    ".cm-lintRange-info": { backgroundImage: "none", textDecoration: `underline wavy ${c.blue}` },
    ".cm-panels": { backgroundColor: c.control, color: c.text },
    ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${c.border}` },
    ".cm-searchMatch": { backgroundColor: `${c.yellow}30`, outline: `1px solid ${c.yellow}80` },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: `${c.copper}40` },
    ".cm-textfield": { backgroundColor: c.panel, color: c.text, border: `1px solid ${c.border}` },
    ".cm-button": { backgroundImage: "none", backgroundColor: c.panel, color: c.text, border: `1px solid ${c.border}` },
  },
  { dark: true },
);

// Syntax colors are restricted to the approved highlight palette:
// copper, PCB green, caution yellow, alarm red, Cherenkov blue.
const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.definitionKeyword], color: c.copper },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: c.green },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: c.yellow },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName), tags.definition(tags.function(tags.variableName))], color: c.blue },
  { tag: [tags.className, tags.typeName, tags.namespace], color: c.blue },
  { tag: [tags.self, tags.standard(tags.variableName), tags.special(tags.variableName)], color: c.copper },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c.muted, fontStyle: "italic" },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: c.yellow },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator], color: c.muted },
  { tag: tags.invalid, color: c.red },
]);

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
    editorTheme,
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
      syntaxHighlighting(highlightStyle),
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
