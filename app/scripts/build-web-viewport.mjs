#!/usr/bin/env node
// Bundles the three.js viewport surface (web/viewport/src/main.ts) into a
// single browser-target file — see build-web-editor.mjs for why this is a
// build artifact, not committed source.
import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await esbuild.build({
  entryPoints: [path.join(appRoot, "web", "viewport", "src", "main.ts")],
  outfile: path.join(appRoot, "web", "viewport", "dist", "bundle.js"),
  bundle: true,
  format: "iife",
  target: "safari15",
  sourcemap: true,
  logLevel: "info",
});
