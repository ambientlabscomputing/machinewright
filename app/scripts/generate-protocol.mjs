#!/usr/bin/env node
// Regenerates the TypeScript bindings for the Machinewright worker protocol
// (../../proto/machinewright_worker.proto) using protoc-gen-es (protobuf-es).
//
// protobuf-es is used instead of ts-proto because it represents `uint64`
// fields (e.g. `generation`) as native `bigint` by default — RFD-19 requires
// that 64-bit wire identities never be coerced into imprecise JS `number`s.
//
// The proto file itself is shared, unmodified source of truth also consumed
// by the Python worker (src/machinewright/protocol/); this script only adds
// a TypeScript consumer, it does not change the wire contract.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(appRoot);
const protoDir = path.join(repoRoot, "proto");
const protoFile = path.join(protoDir, "machinewright_worker.proto");
const outDir = path.join(appRoot, "src", "protocol", "worker");

if (!fs.existsSync(protoFile)) {
  console.error(`proto file not found: ${protoFile}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const protocGenEs = path.join(
  appRoot,
  "node_modules",
  ".bin",
  "protoc-gen-es",
);

execFileSync(
  "protoc",
  [
    `-I${protoDir}`,
    `--plugin=protoc-gen-es=${protocGenEs}`,
    `--es_out=${outDir}`,
    "--es_opt=target=ts",
    path.relative(protoDir, protoFile),
  ],
  { stdio: "inherit", cwd: protoDir },
);

console.log(`Generated worker protocol bindings in ${path.relative(appRoot, outDir)}`);
