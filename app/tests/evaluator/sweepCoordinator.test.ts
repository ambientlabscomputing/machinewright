/**
 * `SweepCoordinator` pool-orchestration tests, driven entirely through
 * `FakeWorkerTransport` (one independent fake per pool slot) and vitest's
 * fake timers — mirroring `coordinator.test.ts`'s style for
 * `EvaluationCoordinator`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SweepCoordinator,
  type SweepPointInput,
  type SweepPointOutcome,
  type SweepRequestInput,
} from "../../src/evaluator/SweepCoordinator";
import { boundedBackoff } from "../../src/evaluator/RetryPolicy";
import { FakeWorkerTransport } from "./fakes/FakeWorkerTransport";

function makePoint(index: number, value: number): SweepPointInput {
  return { index, coordinates: [{ parameterPath: "requirements.payload_kg", value }] };
}

function makeRequest(points: readonly SweepPointInput[]): SweepRequestInput {
  return {
    projectRoot: "/tmp/project",
    templateId: "machinewright.reference.simple",
    templateVersion: "1.0.0",
    baselineInputsJson: new TextEncoder().encode("{}"),
    outputDirectory: "/tmp/out",
    points,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function transportAt(transports: readonly FakeWorkerTransport[], index: number): FakeWorkerTransport {
  const transport = transports[index];
  if (transport === undefined) throw new Error(`no transport spawned at index ${index}`);
  return transport;
}

describe("SweepCoordinator", () => {
  let transports: FakeWorkerTransport[];
  let coordinator: SweepCoordinator;
  let outcomes: SweepPointOutcome[];

  beforeEach(() => {
    vi.useFakeTimers();
    transports = [];
    outcomes = [];
    coordinator = new SweepCoordinator({
      createTransport: () => {
        const transport = new FakeWorkerTransport();
        transports.push(transport);
        return transport;
      },
      workerExecutablePath: "/tmp/project/.venv/bin/machinewright-worker",
      poolSize: 2,
      retryPolicy: boundedBackoff({ maxAttempts: 2, baseMs: 10, maxMs: 20 }),
    });
    coordinator.onPointOutcome((outcome) => outcomes.push(outcome));
  });

  afterEach(() => {
    coordinator.dispose();
    vi.useRealTimers();
  });

  async function handshakeAll(): Promise<void> {
    await flushMicrotasks();
    for (const transport of transports) transport.emitCapabilities();
    await flushMicrotasks();
  }

  it("spawns at most poolSize workers and dispatches one point per idle worker", async () => {
    coordinator.start(makeRequest([makePoint(0, 1), makePoint(1, 2), makePoint(2, 3)]));
    await handshakeAll();

    expect(transports).toHaveLength(2); // poolSize=2, even though there are 3 points
    const dispatched = transports.flatMap((transport) =>
      transport.sentRequests
        .filter((request) => request.request.case === "evaluateSweepPoint")
        .map((request) => (request.request.value as { pointIndex: number }).pointIndex),
    );
    expect(dispatched.sort()).toEqual([0, 1]); // point 2 stays queued until a worker frees up
  });

  it("dispatches the next queued point once a worker completes its current one", async () => {
    coordinator.start(makeRequest([makePoint(0, 1), makePoint(1, 2), makePoint(2, 3)]));
    await handshakeAll();

    transportAt(transports, 0).emitSweepPointCompleted(1n, 0);
    await flushMicrotasks();

    const dispatchedOnFirstWorker = transportAt(transports, 0).sentRequests
      .filter((request) => request.request.case === "evaluateSweepPoint")
      .map((request) => (request.request.value as { pointIndex: number }).pointIndex);
    expect(dispatchedOnFirstWorker).toEqual([0, 2]);
    expect(outcomes).toEqual([{ kind: "completed", result: expect.objectContaining({ pointIndex: 0 }) }]);
  });

  it("requeues a worker's in-flight point on crash and redispatches it after backoff", async () => {
    coordinator.start(makeRequest([makePoint(0, 1), makePoint(1, 2)]));
    await handshakeAll();

    transportAt(transports, 0).emitExit(1); // worker 0 crashes while evaluating point 0
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10); // backoff elapses, worker 0 respawns
    await handshakeAll();

    const dispatchedOnRespawnedWorker = transportAt(transports, 0).sentRequests
      .filter((request) => request.request.case === "evaluateSweepPoint")
      .map((request) => (request.request.value as { pointIndex: number }).pointIndex);
    // Point 0 was in flight when worker 0 crashed, so it must be redispatched
    // once that slot comes back — the crash must not silently drop it. Two
    // sends for point 0 (the original plus the post-crash redispatch) is the
    // signal that recovery actually happened, not just that dispatch works.
    expect(dispatchedOnRespawnedWorker).toEqual([0, 0]);
  });

  it("cancel() drains the pending queue as cancelled outcomes and stops dispatching", async () => {
    coordinator.start(makeRequest([makePoint(0, 1), makePoint(1, 2), makePoint(2, 3)]));
    await handshakeAll();

    coordinator.cancel();
    await flushMicrotasks();

    expect(outcomes).toEqual([{ kind: "cancelled", pointIndex: 2 }]); // point 2 was still queued
    const cancelSweepSent = transports.every((transport) =>
      transport.sentRequests.some((request) => request.request.case === "cancelSweep"),
    );
    expect(cancelSweepSent).toBe(true);

    // A late completion for the already-cancelled sweep must not dispatch anything new.
    transportAt(transports, 0).emitSweepPointCompleted(1n, 0);
    await flushMicrotasks();
    expect(transports.flatMap((t) => t.sentRequests).filter((r) => r.request.case === "evaluateSweepPoint")).toHaveLength(2);
  });

  it("drops events from a superseded sweep id", async () => {
    coordinator.start(makeRequest([makePoint(0, 1)]));
    await handshakeAll();
    coordinator.start(makeRequest([makePoint(0, 5), makePoint(1, 6)])); // new sweep, new id
    await handshakeAll();

    transportAt(transports, 0).emitSweepPointCompleted(1n, 0); // stale sweepId=1, active sweep is now 2
    await flushMicrotasks();
    expect(outcomes).toEqual([]);
  });

  it("reports remaining points as failed once every pool slot exhausts its retry budget", async () => {
    coordinator = new SweepCoordinator({
      createTransport: () => {
        const transport = new FakeWorkerTransport();
        transports.push(transport);
        return transport;
      },
      workerExecutablePath: "/tmp/project/.venv/bin/machinewright-worker",
      poolSize: 1,
      retryPolicy: boundedBackoff({ maxAttempts: 1, baseMs: 5, maxMs: 5 }),
    });
    coordinator.onPointOutcome((outcome) => outcomes.push(outcome));

    coordinator.start(makeRequest([makePoint(0, 1), makePoint(1, 2)]));
    await handshakeAll();

    transportAt(transports, 0).emitExit(1); // first crash: retryAttempt 0 -> 1, backoff scheduled
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5);
    await flushMicrotasks();
    transportAt(transports, 0).emitExit(1); // second crash: retry budget (maxAttempts=1) now exhausted

    expect(outcomes.some((o) => o.kind === "failed" && o.failure.code === "sweep.no_workers_available")).toBe(true);
  });
});
