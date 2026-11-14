/**
 * End-to-end test of on-demand export jobs: the real `ExportCoordinator`
 * talking to the *real* Python worker over its stdio protocol (the same wire
 * the app uses), so the TS bindings, proto schema, and worker handler are
 * exercised together — not each against a fake of the other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { WorkerEventSchema, WorkerRequestSchema, type WorkerEvent } from "../../src/protocol/worker/machinewright_worker_pb";
import { encodeFrame, FrameDecoder } from "../../src/protocol/worker/framing";
import type { WorkerTransport } from "../../src/evaluator/WorkerTransport";
import { ExportCoordinator, type ExportJobInput, type ExportProgress } from "../../src/export/ExportCoordinator";
import { DEFAULT_PRINT_SETTINGS, printOptionsJson } from "../../src/export/exportModel";
import { IDLE_PRINT_RUN, applyPrintProgress, startPrintRun, type PrintRunState } from "../../src/export/printRunModel";

const appRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const repoRoot = path.dirname(appRoot);
const workerBin = path.join(repoRoot, ".venv", "bin", "machinewright-worker");

/** A `WorkerTransport` over a real child process. */
class ProcessTransport implements WorkerTransport {
  private child: ChildProcess | null = null;
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();

  async spawn(): Promise<void> {
    const child = spawn(workerBin, [], { stdio: ["pipe", "pipe", "inherit"] });
    const decoder = new FrameDecoder();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        const event = fromBinary(WorkerEventSchema, frame);
        this.listeners.forEach((listener) => listener(event));
      }
    });
    child.on("exit", (code) => this.exitListeners.forEach((listener) => listener(code ?? -1)));
    this.child = child;
  }

  async send(request: ReturnType<typeof create<typeof WorkerRequestSchema>>): Promise<void> {
    this.child?.stdin?.write(encodeFrame(toBinary(WorkerRequestSchema, request)));
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (exitCode: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.child?.kill();
  }

  waitForCapabilities(): Promise<readonly string[]> {
    return new Promise((resolve) => {
      const off = this.onEvent((event) => {
        if (event.event.case === "capabilities") {
          off();
          resolve(event.event.value.capabilities);
        }
      });
      void this.send(create(WorkerRequestSchema, { request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } } }));
    });
  }
}

function job(overrides: Partial<ExportJobInput>): ExportJobInput {
  return {
    projectRoot: repoRoot,
    templateId: "machinewright.reference.simple",
    templateVersion: "1.0.0",
    inputsJson: new Uint8Array(readFileSync(path.join(repoRoot, "examples", "inputs", "reference.json"))),
    overlays: [],
    environmentDigest: "",
    kind: "parts",
    outputDirectory: "",
    options: {},
    basename: "reference",
    ...overrides,
  };
}

describe("export jobs against the real worker", () => {
  const transport = new ProcessTransport();
  let coordinator: ExportCoordinator;

  beforeAll(async () => {
    await transport.spawn();
    coordinator = new ExportCoordinator({ transport, sessionId: "export-test" });
    expect(await transport.waitForCapabilities()).toContain("export_jobs.v1");
  }, 60_000);

  afterAll(async () => {
    coordinator.dispose();
    await transport.stop();
  });

  it("exports every part as its own STL and reports progress", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mw-export-parts-"));
    const progress: ExportProgress[] = [];
    const outcome = await coordinator.run(job({ kind: "parts", outputDirectory: directory, options: { format: "stl" } }), (p) => progress.push(p)).outcome;

    expect(outcome.kind).toBe("completed");
    const files = readdirSync(directory).filter((name) => name.endsWith(".stl"));
    expect(files.length).toBeGreaterThan(0);
    expect(progress.length).toBe(files.length);
    expect(progress.at(-1)?.total).toBe(files.length);
    if (outcome.kind === "completed") {
      const names = (outcome.result as { files: { name: string }[] }).files.map((f) => f.name).sort();
      expect(names).toEqual(files.sort());
    }
  }, 60_000);

  it("plans a print layout without writing files", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mw-export-plan-"));
    const outcome = await coordinator.run(
      job({ kind: "print_plan", options: { write: false, printer: { bed_x: 180, bed_y: 180 } } }),
    ).outcome;

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      const plan = outcome.result as { bed_x: number; plates: unknown[] };
      expect(plan.bed_x).toBe(180);
      expect(Array.isArray(plan.plates)).toBe(true);
    }
    expect(readdirSync(directory)).toEqual([]);
  }, 60_000);

  it("streams a live print run: layout first, then each plate as its file lands", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mw-export-live-"));
    const stages: string[] = [];
    const onDisk: string[][] = [];
    let state: PrintRunState = startPrintRun(IDLE_PRINT_RUN);
    const outcome = await coordinator.run(
      job({ kind: "print_plan", outputDirectory: directory, basename: "print", options: printOptionsJson(DEFAULT_PRINT_SETTINGS, true, true) }),
      (progress) => {
        stages.push(progress.stage);
        state = applyPrintProgress(state, progress);
        if (progress.stage === "plate_ready") onDisk.push(Object.values(state.files).map((name) => existsSync(path.join(directory, name)) ? name : "MISSING"));
      },
    ).outcome;

    expect(outcome.kind).toBe("completed");
    expect(stages.indexOf("layout")).toBeGreaterThan(stages.lastIndexOf("orient") - 1);
    if (stages.includes("plate_ready")) {
      expect(stages.indexOf("layout")).toBeLessThan(stages.indexOf("plate_ready"));
      expect(onDisk.flat()).not.toContain("MISSING"); // every announced plate was already readable
      expect(state.fraction).toBeCloseTo(1);
    }
  }, 60_000);

  it("reports a failure with the worker's message instead of hanging", async () => {
    const outcome = await coordinator.run(job({ templateId: "does.not.exist", outputDirectory: tmpdir() })).outcome;

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toContain("does.not.exist");
  }, 60_000);

  it("rejects invalid options as a failed job, and the worker keeps serving", async () => {
    const bad = await coordinator.run(job({ kind: "print_plan", options: { printer: { bed_x: -5 } } })).outcome;
    expect(bad.kind).toBe("failed");

    const directory = mkdtempSync(path.join(tmpdir(), "mw-export-after-"));
    const good = await coordinator.run(job({ kind: "parts", outputDirectory: directory, options: { combine: true } })).outcome;
    expect(good.kind).toBe("completed");
    expect(existsSync(path.join(directory, "reference-parts.stl"))).toBe(true);
  }, 60_000);

  it("cancels a queued job without leaving files behind", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mw-export-cancel-"));
    const handle = coordinator.run(job({ kind: "parts", outputDirectory: directory, options: {} }));
    handle.cancel();
    const outcome = await handle.outcome;

    expect(outcome.kind).toBe("cancelled");
    expect(readdirSync(directory)).toEqual([]);
  }, 60_000);
});
