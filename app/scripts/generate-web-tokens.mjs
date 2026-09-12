#!/usr/bin/env node
// Generates CSS custom properties and a viewport theme JSON from
// src/design-system/tokens, so the RN shell and the bundled WebView
// surfaces (CodeMirror, three.js) consume one source of design tokens
// instead of maintaining separate copies (RFD-19, "Enforcing the design
// language": "Generate WebView CSS variables and viewport theme data from
// these definitions so the runtimes share one source").
//
// Source files are hand-written TS token modules (not generated); only
// this CSS/JSON projection is generated output.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Node >=22.18/23.6 executes erasable TypeScript syntax natively, so the
// token module can be imported directly with no build step or extra
// toolchain (ts-node, etc.) — the token files use only `as const`/type
// annotations, no TS features that need transformation.
const { colors } = await import(
  path.join(appRoot, "src", "design-system", "tokens", "colors.ts")
);

function flatten(prefix, node, out) {
  for (const [key, value] of Object.entries(node)) {
    const name = prefix ? `${prefix}-${key}` : key;
    if (typeof value === "string" || typeof value === "number") {
      out.push([name, value]);
    } else {
      flatten(name, value, out);
    }
  }
}

const pairs = [];
flatten("color", colors, pairs);

const cssLines = [":root {", ...pairs.map(([name, value]) => `  --mw-${name}: ${value};`), "}"];

const outDir = path.join(appRoot, "web", "design-system", "generated");
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "tokens.css"), cssLines.join("\n") + "\n");
await fs.writeFile(
  path.join(outDir, "viewport-theme.json"),
  JSON.stringify(Object.fromEntries(pairs.map(([name, value]) => [name, value])), null, 2) + "\n",
);

console.log("Generated web/design-system/generated/{tokens.css,viewport-theme.json}");
