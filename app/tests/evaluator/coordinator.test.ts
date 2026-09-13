/**
 * `EvaluationCoordinator` state-machine tests, driven entirely through
 * `FakeWorkerTransport` and vitest's fake timers — no app launch, no
 * NativeModules, mirroring the existing `worker-roundtrip.test.ts` style
 * for framework-neutral protocol/model contracts.
 *
 * Each test names the deleted Rust UI review finding (R2/R4/R7) it guards
 * against regressing, per the M2 plan's "name the mechanism" requirement.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationCoordinator, type EvaluationInput, type EvaluationOutcome, type WorkerHealth } from "../../src/evaluator/EvaluationCoordinator";
import { boundedBackoff } from "../../src/evaluator/RetryPolicy";
import { FakeWorkerTransport } from "./fakes/FakeWorkerTransport";

function makeInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    projectRoot: "/tmp/project",
    templateId: "machinewright.reference.simple",
    templateVersion: "1.0.0",
    inputsJson: new TextEncoder().encode("{}"),
    outputDirectory: "/tmp/out",
    overlays: [],
    environmentDigest: "",
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EvaluationCoordinator", () => {
  let transport: FakeWorkerTransport;
  let coordinator: EvaluationCoordinator;
  let healthHistory: WorkerHealth[];
  let outcomes: EvaluationOutcome[];

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeWorkerTransport();
    healthHistory = [];
    outcomes = [];
    coordinator = new EvaluationCoordinator({
      transport,
      workerExecutablePath: "/tmp/project/.venv/bin/machinewright-worker",
      debounceMs: 100,
      retryPolicy: boundedBackoff({ maxAttempts: 2, baseMs: 10, maxMs: 20 }),
    });
    coordinator.onHealthChange((health) => healthHistory.push(health));
    coordinator.onOutcome((outcome) => outcomes.push(outcome));
  });

  afterEach(() => {
    coordinator.dispose();
    vi.useRealTimers();
  });

  async function requestAndAdvanceToSpawn(input: EvaluationInput): Promise<void> {
    coordinator.requestEvaluation(input);
    await vi.advanceTimersByTimeAsync(100); // debounce fires
    await flushMicrotasks();
  }

  it("spawns and handshakes the worker before submitting the first request", async () => {
    await requestAndAdvanceToSpawn(makeInput());

    expect(transport.spawnCalls).toHaveLength(1);
    expect(transport.spawnCalls[0]?.executablePath).toBe("/tmp/project/.venv/bin/machinewright-worker");
    expect(transport.sentRequests.map((r) => r.request.case)).toEqual(["hello"]);
    expect(coordinator.getHealth().phase).toBe("handshaking");

    transport.emitCapabilities();
    await flushMicrotasks();

    expect(coordinator.getHealth().phase).toBe("evaluating");
    expect(transport.sentRequests.map((r) => r.request.case)).toEqual(["hello", "evaluate"]);
  });

  it("debounces rapid successive requestEvaluation calls into a single submission", async () => {
    coordinator.requestEvaluation(makeInput({ templateVersion: "1.0.0" }));
    await vi.advanceTimersByTimeAsync(50);
    coordinator.requestEvaluation(makeInput({ templateVersion: "1.0.1" })); // resets the debounce timer
    await vi.advanceTimersByTimeAsync(50);
    expect(transport.spawnCalls).toHaveLength(0); // still debounced, timer reset by the second call

    await vi.advanceTimersByTimeAsync(50); // now 100ms since the second call
    await flushMicrotasks();
    expect(transport.spawnCalls).toHaveLength(1); // exactly one worker spawn, for the latest input only
  });

  it("R2: reevaluates identically regardless of which document-change origin triggered requestEvaluation", async () => {
    // The coordinator has no notion of "origin" at all — DocumentStore is
    // what forwards every origin identically (see documentStore.test.ts).
    // This test confirms the coordinator side of that contract: calling
    // requestEvaluation always debounces-and-submits, with no special case.
    await requestAndAdvanceToSpawn(makeInput());
    transport.emitCapabilities();
    await flushMicrotasks();
    expect(coordinator.getHealth().phase).toBe("evaluating");
  });

  it("supersedes an in-flight evaluation: sends advisory cancel for the old generation, then immediately the new one, and drops the old generation's late completion", async () => {
    await requestAndAdvanceToSpawn(makeInput());
    transport.emitCapabilities();
    await flushMicrotasks();
    const firstGeneration = (coordinator.getHealth() as { phase: "evaluating"; generation: bigint }).generation;

    // A new edit arrives while generation 1 is still evaluating.
    coordinator.requestEvaluation(makeInput({ templateVersion: "2.0.0" }));
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    const cases = transport.sentRequests.map((r) => r.request.case);
    expect(cases).toEqual(["hello", "evaluate", "cancel", "evaluate"]);
    const secondGeneration = (coordinator.getHealth() as { phase: "evaluating"; generation: bigint }).generation;
    expect(secondGeneration).toBeGreaterThan(firstGeneration);

    // The worker's FIFO queue can still let the old (cooperatively
    // cancelled) generation finish and report completion late — this must
    // be dropped unconditionally, not treated as the current result.
    transport.emitCompleted(firstGeneration);
    await flushMicrotasks();
    expect(outcomes).toHaveLength(0);

    transport.emitCompleted(secondGeneration);
    await flushMicrotasks();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ kind: "completed", result: { generation: secondGeneration } });
  });

  it("R4: retry() after a crash both respawns the worker and resends the last request as one transition, under the same generation", async () => {
    await requestAndAdvanceToSpawn(makeInput());
    transport.emitCapabilities();
    await flushMicrotasks();
    const generation = (coordinator.getHealth() as { phase: "evaluating"; generation: bigint }).generation;

    transport.emitExit(1);
    expect(coordinator.getHealth()).toMatchObject({ phase: "worker_unhealthy", exitCode: 1 });

    // Manual "Retry Worker" command — must not merely clear the unhealthy
    // status; it must actually reconnect and resubmit.
    const spawnCallsBeforeRetry = transport.spawnCalls.length;
    coordinator.retry();
    await flushMicrotasks();
    expect(transport.spawnCalls.length).toBeGreaterThan(spawnCallsBeforeRetry);
    expect(coordinator.getHealth().phase).toBe("handshaking");

    transport.emitCapabilities();
    await flushMicrotasks();

    // Resent under the SAME generation — nothing was ever displayed for it.
    expect(coordinator.getHealth()).toMatchObject({ phase: "evaluating", generation });
    const evaluateRequests = transport.sentRequests.filter((r) => r.request.case === "evaluate");
    expect(evaluateRequests).toHaveLength(2); // original + resend
    expect(evaluateRequests[1]?.request.value).toMatchObject({ generation });
  });

  it("R4: automatic bounded-backoff retry keeps respawning a repeatedly-crashing worker, then gives up and requires manual retry once exhausted", async () => {
    // A worker that crashes again before ever completing a handshake — the
    // retry attempt counter only resets on a *successful* capabilities
    // receipt (see EvaluationCoordinator.handleEvent), so this is what
    // actually accumulates toward exhaustion, as opposed to a worker that
    // recovers fully each time (which legitimately resets the counter).
    await requestAndAdvanceToSpawn(makeInput());
    transport.emitCapabilities();
    await flushMicrotasks();

    // First crash: automatic retry (attempt 0 -> backoff 10ms).
    transport.emitExit(1);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(coordinator.getHealth().phase).toBe("handshaking");

    // Crashes again before handshaking completes: automatic retry (attempt 1 -> backoff 20ms).
    transport.emitExit(1);
    await vi.advanceTimersByTimeAsync(20);
    await flushMicrotasks();
    expect(coordinator.getHealth().phase).toBe("handshaking");

    // Crashes a third time: maxAttempts (2) exhausted — coordinator must NOT
    // keep retrying on its own; it must sit in worker_unhealthy until an
    // explicit retry() call, never silently clearing the unhealthy status.
    const spawnCallsBeforeThirdCrash = transport.spawnCalls.length;
    transport.emitExit(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(coordinator.getHealth().phase).toBe("worker_unhealthy");
    expect(transport.spawnCalls.length).toBe(spawnCallsBeforeThirdCrash); // no silent auto-retry

    coordinator.retry();
    await flushMicrotasks();
    expect(transport.spawnCalls.length).toBeGreaterThan(spawnCallsBeforeThirdCrash);
    expect(coordinator.getHealth().phase).toBe("handshaking");

    // A full recovery from here resets the attempt counter and resends the
    // still-pending original request, under its original generation.
    transport.emitCapabilities();
    await flushMicrotasks();
    expect(coordinator.getHealth().phase).toBe("evaluating");
  });

  it("R7: a newer edit that arrives while the worker is unhealthy wins over resending the stale request, under a fresh generation", async () => {
    await requestAndAdvanceToSpawn(makeInput());
    transport.emitCapabilities();
    await flushMicrotasks();
    const firstGeneration = (coordinator.getHealth() as { phase: "evaluating"; generation: bigint }).generation;

    transport.emitExit(1);
    // A new edit arrives before recovery completes.
    coordinator.requestEvaluation(makeInput({ templateVersion: "3.0.0" }));
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    coordinator.retry();
    await flushMicrotasks();
    transport.emitCapabilities();
    await flushMicrotasks();

    const health = coordinator.getHealth();
    expect(health.phase).toBe("evaluating");
    expect((health as { generation: bigint }).generation).toBeGreaterThan(firstGeneration);
  });

  it("drops a failed-generation event that is older than the latest requested generation", async () => {
    await requestAndAdvanceToSpawn(makeInput());
    transport.emitCapabilities();
    await flushMicrotasks();
    const firstGeneration = (coordinator.getHealth() as { phase: "evaluating"; generation: bigint }).generation;

    coordinator.requestEvaluation(makeInput({ templateVersion: "4.0.0" }));
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();

    transport.emitFailed(firstGeneration);
    await flushMicrotasks();
    expect(outcomes).toHaveLength(0);
  });
});
