#!/usr/bin/env node
// Design-system import/token boundary checks (RFD-19 "Enforcing the design
// language"), adapted from fabricate/ui/scripts/check-boundaries.mjs.
//
// Static `no-restricted-imports` ESLint rules alone are insufficient (RFD-19
// explicitly calls this out: "supplement static import restrictions with a
// module-boundary rule that resolves aliases and relative paths and checks
// re-exports, `require`, and dynamic imports"), so this script does a plain
// text/AST-light walk that also catches re-export barrels, CJS require,
// dynamic imports, and namespace-import property access — see
// scripts/boundary-rules.mjs for the actual pattern matching (kept separate
// so it's directly unit-testable) and tests/scripts/boundary-rules.test.ts
// for the positive/negative fixtures RFD-19 asks for.
//
// This intentionally starts narrow: only the checks that have a real
// enforcement target today (raw color literals; raw RN visual primitives
// outside the native design system). Checks for a specific vendor
// component library are unnecessary — DECISION.md in
// src/design-system/native/ records that this milestone deliberately
// wraps plain react-native primitives rather than adopting one.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hasRestrictedRnPrimitiveImport, hasRawColorLiteral, isUnder } from "./boundary-rules.mjs";

const appRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const failures = [];

const EXEMPT_FROM_RAW_COLOR = [
  path.join("src", "design-system", "tokens"),
  path.join("web", "design-system", "generated"),
];
const EXEMPT_FROM_RN_PRIMITIVE_RESTRICTION = [
  path.join("src", "design-system", "native"),
  // Spike-only host components (B.2/B.3/B.4/B.5) predate the native design
  // system: DECISION.md records the (already-resolved) choice, but
  // retrofitting these already-verified spike screens onto the new
  // wrappers is M2 product-shell work, not this milestone's — the wrapper
  // library and its enforcement are the actual M1 deliverable.
  path.join("src", "viewport"),
  path.join("src", "editor"),
  path.join("src", "app"),
];

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist yet (e.g. src/ before Phase B scaffolding lands)
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(target);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.generated\.ts$/.test(entry.name)) continue;

    const relative = path.relative(appRoot, target);
    if (relative.startsWith(path.join("src", "protocol", "worker"))) continue; // protoc-gen-es output
    if (relative.startsWith(path.join("src", "model", "generated"))) continue; // json-schema-to-typescript output

    const source = await readFile(target, "utf8");

    if (hasRawColorLiteral(source) && !isUnder(relative, EXEMPT_FROM_RAW_COLOR, path.sep)) {
      failures.push(`${relative}: raw color literal outside design-system/tokens`);
    }
    if (
      hasRestrictedRnPrimitiveImport(source) &&
      !isUnder(relative, EXEMPT_FROM_RN_PRIMITIVE_RESTRICTION, path.sep)
    ) {
      failures.push(`${relative}: raw react-native visual primitive outside design-system/native`);
    }
  }
}

await walk(path.join(appRoot, "src"));
await walk(path.join(appRoot, "web"));

if (failures.length) {
  process.stderr.write(failures.join("\n") + "\n");
  process.exitCode = 1;
}
