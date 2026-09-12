#!/usr/bin/env node
// Regenerates TypeScript types for the EvaluationSnapshot payload (the JSON
// body referenced by the worker protocol's `snapshot_path`, as opposed to
// the protobuf envelope handled by generate-protocol.mjs) from the JSON
// Schema Python already generates via `make generate`
// (scripts/generate_schemas.py -> src/machinewright/schemas/*.schema.json).
//
// This keeps the TS model layer generated from the same source of truth as
// the Python side, rather than hand-typed and prone to drifting from it.

import { compile } from "json-schema-to-typescript";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(appRoot);
const schemaDir = path.join(repoRoot, "src", "machinewright", "schemas");
const outDir = path.join(appRoot, "src", "model", "generated");

// Only the snapshot body is needed by the app today; extend this list if
// another top-level contract needs a generated TS type.
const SCHEMAS = ["EvaluationSnapshot-1.0.schema.json"];

await fs.mkdir(outDir, { recursive: true });

for (const fileName of SCHEMAS) {
  const schemaPath = path.join(schemaDir, fileName);
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
  const typeName = fileName.split("-")[0];
  const ts = await compile(schema, typeName, {
    additionalProperties: false,
    bannerComment:
      "/* eslint-disable */\n" +
      `/**\n * Generated from ${path.relative(repoRoot, schemaPath)}.\n` +
      " * Do not edit by hand — run `npm run generate:model`.\n */",
    style: { singleQuote: false },
  });
  const outPath = path.join(outDir, `${typeName}.ts`);
  await fs.writeFile(outPath, ts);
  console.log(`Generated ${path.relative(appRoot, outPath)}`);
}
