#!/usr/bin/env node
// Bundles the CodeMirror 6 editor surface (web/editor/src/main.ts) into a
// single browser-target file the WKWebView loads offline (RFD-19 hard
// requirement #2 — no dev server). This is a build artifact, not
// generated *source* like the protocol/model codegen, so it is not
// committed (see .gitignore) — it must be rebuilt before packaging,
// exactly like Metro's own JS bundle for the RN shell.
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(appRoot, "web", "editor", "src", "main.ts")],
  outfile: path.join(appRoot, "web", "editor", "dist", "bundle.js"),
  bundle: true,
  format: "iife",
  target: "safari15",
  sourcemap: true,
  logLevel: "info",
});
