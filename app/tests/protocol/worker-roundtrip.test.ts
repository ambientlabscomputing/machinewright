/**
 * Contract test for the M0 acceptance criterion: TS bindings must read the
 * worker protocol's 64-bit `generation` identity losslessly (RFD-19: "these
 * must not be coerced into imprecise JavaScript numbers").
 *
 * This spawns the *real* Python worker (not a mock) over its actual stdio
 * transport and round-trips a generation value beyond
 * Number.MAX_SAFE_INTEGER (2^53 - 1), which would silently lose precision
 * if the TS side ever represented it as `number` instead of `bigint`.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  WorkerRequestSchema,
  WorkerEventSchema,
  type WorkerEvent,
} from "../../src/protocol/worker/machinewright_worker_pb";
import { encodeFrame, FrameDecoder } from "../../src/protocol/worker/framing";

const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const repoRoot = path.dirname(appRoot);
const workerBin = path.join(repoRoot, ".venv", "bin", "machinewright-worker");

// Beyond Number.MAX_SAFE_INTEGER: exercises the exact failure mode the RFD
// warns about (2**53 + 1 is not exactly representable as a JS `number`).
const PRECISION_PROBE_GENERATION = 9007199254740993n;

/** Minimal stdio harness around the worker subprocess for this one test. */
function launchWorker() {
  const child = spawn(workerBin, [], { stdio: ["pipe", "pipe", "inherit"] });
  const decoder = new FrameDecoder();
  const pending: WorkerEvent[] = [];
  const waiters: ((event: WorkerEvent) => void)[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      const event = fromBinary(WorkerEventSchema, frame);
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else pending.push(event);
    }
  });

  function nextEvent(): Promise<WorkerEvent> {
    const buffered = pending.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => waiters.push(resolve));
  }

  function send(request: ReturnType<typeof create<typeof WorkerRequestSchema>>) {
    child.stdin.write(encodeFrame(toBinary(WorkerRequestSchema, request)));
  }

  return { child, send, nextEvent };
}

describe("worker protocol round-trip", () => {
  it(
    "preserves a 64-bit generation id exactly through a real evaluation",
    async () => {
      const { child, send, nextEvent } = launchWorker();
      try {
        send(create(WorkerRequestSchema, { request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } } }));
        const capabilities = await nextEvent();
        expect(capabilities.event.case).toBe("capabilities");

        const outputDirectory = mkdtempSync(path.join(tmpdir(), "mw-app-protocol-test-"));
        const inputsJson = readFileSync(
          path.join(repoRoot, "examples", "inputs", "reference.json"),
        );

        send(
          create(WorkerRequestSchema, {
            request: {
              case: "evaluate",
              value: {
                sessionId: "protocol-contract-test",
                generation: PRECISION_PROBE_GENERATION,
                projectRoot: repoRoot,
                templateId: "machinewright.reference.simple",
                templateVersion: "1.0.0",
                inputsJson: new Uint8Array(inputsJson),
                outputDirectory,
                overlays: [],
                environmentDigest: "",
              },
            },
          }),
        );

        let result = await nextEvent();
        while (result.event.case === "progress") {
          result = await nextEvent();
        }
        expect(result.event.case).toBe("completed");
        if (result.event.case !== "completed") throw new Error("unreachable");
        expect(result.event.value.generation).toBe(PRECISION_PROBE_GENERATION);
        expect(typeof result.event.value.generation).toBe("bigint");
      } finally {
        child.kill();
      }
    },
    30_000,
  );
});
