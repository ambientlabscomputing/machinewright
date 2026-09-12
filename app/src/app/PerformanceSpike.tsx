/**
 * B.7: performance measurement (RFD-19 architecture-spike step
 * "Responsiveness and resource budgets" — "measure, don't assume").
 *
 * Three independent measurements, each a thin harness over infrastructure
 * already built in earlier spike phases — this screen adds no new product
 * surface, only instrumentation:
 *  - viewport frame rate at a synthetic triangle count (drives
 *    web/viewport/src/main.ts's benchmarkSynthetic/benchmarkResult pair)
 *  - worker-restart latency: stop() -> spawn() -> next CapabilityReport
 *  - 100-point sweep wall time: 100 sequential real evaluations against
 *    the reference project, varying one input, run strictly sequentially
 *    (matching how a real sweep would drive one long-lived worker rather
 *    than parallelizing — see R1/R12 in the design decisions)
 *
 * Numbers observed here are recorded, with the macOS version/CPU
 * architecture they were measured on, in docs/performance-budgets.md —
 * this screen is how those numbers were produced, not a permanent product
 * feature.
 */
import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import WebView from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { Text } from "../design-system/native/Text";
import { Stack } from "../design-system/native/Stack";
import { Panel } from "../design-system/native/Panel";
import { Button } from "../design-system/native/Button";
import { colors } from "../design-system/tokens/colors";
import { getBundledAssetURL } from "../native/BundledAssets";
import { WorkerBridge } from "../native/WorkerBridge";
import { WorkerRequestSchema } from "../protocol/worker/machinewright_worker_pb";
import {
  serializeViewportHostCommand,
  deserializeViewportSurfaceEvent,
} from "../protocol/surfaces/viewport";

const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const WORKER_PATH = `${REPO_ROOT}/.venv/bin/machinewright-worker`;
const OUTPUT_DIRECTORY = "/tmp/machinewright-app-perf-spike";

interface WebViewRefLike {
  postMessage: (message: string) => void;
}

// --- Viewport frame-rate benchmark -------------------------------------------

type BenchmarkPhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "waiting_for_ready"; triangleCount: number }
  | { phase: "running"; triangleCount: number };

function ViewportBenchmark() {
  const [url, setUrl] = useState<string | null>(null);
  const [results, setResults] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<BenchmarkPhase>({ phase: "idle" });
  const webViewRef = useRef<WebViewRefLike>(null);
  // A command sent before the WebView's own JS has run posts into a page
  // with no "message" listener attached yet and is silently lost — so a
  // benchmark request made before "ready" arrives is queued, not sent
  // immediately (the bug ViewportHost.tsx already avoids by never sending
  // prepareSnapshot until its own "ready" event; this screen's first draft
  // used a blind setTimeout instead and lost every command to that race).
  const pendingTriangleCount = useRef<number | null>(null);
  const webViewReady = useRef(false);

  const runBenchmark = useCallback((triangleCount: number) => {
    if (webViewReady.current) {
      setStatus({ phase: "running", triangleCount });
      webViewRef.current?.postMessage(
        serializeViewportHostCommand({ kind: "benchmarkSynthetic", triangleCount }),
      );
      return;
    }
    pendingTriangleCount.current = triangleCount;
    if (url) {
      setStatus({ phase: "waiting_for_ready", triangleCount });
      return;
    }
    setStatus({ phase: "loading" });
    void getBundledAssetURL("web/viewport/index.html").then(setUrl);
  }, [url]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const surfaceEvent = deserializeViewportSurfaceEvent(event.nativeEvent.data);
    if (surfaceEvent.kind === "ready") {
      webViewReady.current = true;
      const queued = pendingTriangleCount.current;
      if (queued !== null) {
        pendingTriangleCount.current = null;
        setStatus({ phase: "running", triangleCount: queued });
        webViewRef.current?.postMessage(
          serializeViewportHostCommand({ kind: "benchmarkSynthetic", triangleCount: queued }),
        );
      }
      return;
    }
    if (surfaceEvent.kind === "benchmarkResult") {
      setResults((previous) => [
        `${surfaceEvent.triangleCount.toLocaleString()} triangles: ${surfaceEvent.fps.toFixed(1)} fps ` +
          `(${surfaceEvent.frames} frames / ${surfaceEvent.durationMs.toFixed(0)} ms)`,
        ...previous,
      ]);
      setStatus({ phase: "idle" });
    }
  }, []);

  const running = status.phase !== "idle";

  return (
    <Panel surface="panel" bordered>
      <Stack gap="sm">
        <Text variant="heading">Viewport frame rate</Text>
        <Stack direction="row" gap="sm">
          <Button label="100k triangles" disabled={running} onPress={() => runBenchmark(100_000)} />
          <Button label="1M triangles" disabled={running} onPress={() => runBenchmark(1_000_000)} />
        </Stack>
        <Text variant="label" tone="secondary">
          status: {status.phase}
        </Text>
        {url ? (
          <View style={styles.hiddenWebView}>
            <WebView
              ref={webViewRef}
              source={{ uri: url }}
              originWhitelist={["file://*"]}
              onMessage={onMessage}
            />
          </View>
        ) : null}
        <Stack gap="xs">
          {results.map((line, index) => (
            <Text key={index} variant="mono" numeric>
              {line}
            </Text>
          ))}
        </Stack>
      </Stack>
    </Panel>
  );
}

// --- Worker restart latency ---------------------------------------------------

function waitForCapabilities(bridge: WorkerBridge): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = bridge.onEvent((event) => {
      if (event.event.case === "capabilities") {
        unsubscribe();
        resolve();
      }
    });
  });
}

function waitForExit(bridge: WorkerBridge): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = bridge.onExit(() => {
      unsubscribe();
      resolve();
    });
  });
}

async function handshake(bridge: WorkerBridge): Promise<void> {
  const capabilities = waitForCapabilities(bridge);
  await bridge.send(
    create(WorkerRequestSchema, {
      request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } },
    }),
  );
  await capabilities;
}

/**
 * `stop()` (macos/MachinewrightApp-macOS/MachinewrightWorkerModule.swift)
 * calls `Process.terminate()` and resolves immediately — the process is
 * only actually reaped, and `spawn()` only becomes callable again, once the
 * async `terminationHandler` fires and clears native state. Awaiting
 * `stop()` alone is not enough to safely `spawn()` again: doing so races
 * "worker_already_running" intermittently. This is what an honest restart-
 * latency measurement has to wait through, not around.
 */
async function restart(bridge: WorkerBridge): Promise<void> {
  const exited = waitForExit(bridge);
  await bridge.stop();
  await exited;
  await bridge.spawn(WORKER_PATH, []);
  await handshake(bridge);
}

function RestartLatency() {
  const [log, setLog] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);

  const measure = useCallback(async (trials: number) => {
    setRunning(true);
    setLog([]);
    const bridge = new WorkerBridge();
    await bridge.spawn(WORKER_PATH, []);
    await handshake(bridge);
    const samplesMs: number[] = [];
    for (let trial = 0; trial < trials; trial++) {
      const start = performance.now();
      await restart(bridge);
      const elapsed = performance.now() - start;
      samplesMs.push(elapsed);
      setLog((previous) => [...previous, `trial ${trial + 1}: ${elapsed.toFixed(0)} ms`]);
    }
    await bridge.stop();
    const avg = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
    setLog((previous) => [
      ...previous,
      `avg ${avg.toFixed(0)} ms / min ${Math.min(...samplesMs).toFixed(0)} ms / max ${Math.max(...samplesMs).toFixed(0)} ms`,
    ]);
    setRunning(false);
  }, []);

  return (
    <Panel surface="panel" bordered>
      <Stack gap="sm">
        <Text variant="heading">Worker restart latency (spawn -&gt; CapabilityReport)</Text>
        <Button label="Measure (5 trials)" disabled={running} onPress={() => void measure(5)} />
        <Stack gap="xs">
          {log.map((line, index) => (
            <Text key={index} variant="mono" numeric>
              {line}
            </Text>
          ))}
        </Stack>
      </Stack>
    </Panel>
  );
}

// --- 100-point sweep wall time ------------------------------------------------

function SweepTiming() {
  const [log, setLog] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);

  const runSweep = useCallback(async (points: number) => {
    setRunning(true);
    setLog([`running ${points}-point sweep...`]);
    const bridge = new WorkerBridge();
    await bridge.spawn(WORKER_PATH, []);
    await handshake(bridge);

    const start = performance.now();
    for (let point = 0; point < points; point++) {
      const generation = BigInt(point + 1);
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = bridge.onEvent((event) => {
          if (event.event.case === "completed" && event.event.value.generation === generation) {
            unsubscribe();
            resolve();
          } else if (event.event.case === "failed") {
            unsubscribe();
            reject(new Error(event.event.value.message));
          }
        });
        void bridge.send(
          create(WorkerRequestSchema, {
            request: {
              case: "evaluate",
              value: {
                sessionId: "app-perf-spike-sweep",
                generation,
                projectRoot: REPO_ROOT,
                templateId: "machinewright.reference.simple",
                templateVersion: "1.0.0",
                inputsJson: new TextEncoder().encode(
                  JSON.stringify({ requirements: { payload_kg: 1 + point } }),
                ),
                outputDirectory: `${OUTPUT_DIRECTORY}/point-${point}`,
                overlays: [],
                environmentDigest: "",
              },
            },
          }),
        );
      });
    }
    const elapsed = performance.now() - start;
    await bridge.stop();
    setLog((previous) => [
      ...previous,
      `${points} points: ${elapsed.toFixed(0)} ms total (${(elapsed / points).toFixed(0)} ms/point avg)`,
    ]);
    setRunning(false);
  }, []);

  return (
    <Panel surface="panel" bordered>
      <Stack gap="sm">
        <Text variant="heading">100-point sweep wall time</Text>
        <Text variant="label" tone="secondary">
          Sequential evaluate calls against one long-lived worker (never spawn-per-point — the R1 fix
          this exercises).
        </Text>
        <Button label="Run 100-point sweep" disabled={running} onPress={() => void runSweep(100)} />
        <Stack gap="xs">
          {log.map((line, index) => (
            <Text key={index} variant="mono" numeric>
              {line}
            </Text>
          ))}
        </Stack>
      </Stack>
    </Panel>
  );
}

export function PerformanceSpike() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Stack gap="lg">
        <ViewportBenchmark />
        <RestartLatency />
        <SweepTiming />
      </Stack>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  hiddenWebView: {
    width: 400,
    height: 300,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
});
