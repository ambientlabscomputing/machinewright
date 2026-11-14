/**
 * Application entry point. `AppShell` (src/app/AppShell.tsx) is the real
 * Machinewright product surface built in M2. The B.1-B.7 architecture-spike
 * screens that predate it stay reachable under "Dev Tools" — each remains
 * independently re-verifiable from its own tab, exactly as it was before
 * M2, just no longer the default experience.
 */
import { useCallback, useRef, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { WorkerRequestSchema } from "./src/protocol/worker/machinewright_worker_pb";
import { WorkerBridge } from "./src/native/WorkerBridge";
import { ViewportHost } from "./src/viewport/ViewportHost";
import { EditorHost } from "./src/editor/EditorHost";
import { SelectionSyncSpike } from "./src/app/SelectionSyncSpike";
import { PerformanceSpike } from "./src/app/PerformanceSpike";
import { BehaviorLabSpike } from "./src/app/BehaviorLabSpike";
import { ComponentGallery } from "./src/design-system/gallery/ComponentGallery";
import { AppShell } from "./src/app/AppShell";
import { colors } from "./src/design-system/tokens/colors";

// Spike-only: a real project-open flow (native file picker → workspace/)
// replaces this hardcoded path once M2 builds the actual product shell.
const REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright";
const WORKER_PATH = `${REPO_ROOT}/.venv/bin/machinewright-worker`;

type Status =
  | { phase: "idle" }
  | { phase: "spawning" }
  | { phase: "awaiting_capabilities" }
  | { phase: "ready"; capabilities: readonly string[] }
  | { phase: "evaluating" }
  | { phase: "completed"; graphDigest: string; generation: string }
  | { phase: "failed"; message: string }
  | { phase: "worker_exited"; exitCode: number };

function WorkerBridgeSpike() {
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const [log, setLog] = useState<string[]>([]);
  const bridgeRef = useRef<WorkerBridge | null>(null);

  const appendLog = useCallback((line: string) => {
    setLog((previous) => [...previous, line]);
  }, []);

  const runSpike = useCallback(async () => {
    const bridge = new WorkerBridge();
    bridgeRef.current = bridge;

    bridge.onExit((exitCode) => {
      appendLog(`worker exited (code ${exitCode})`);
      setStatus({ phase: "worker_exited", exitCode });
    });

    const unsubscribe = bridge.onEvent((event) => {
      switch (event.event.case) {
        case "capabilities":
          appendLog(`capabilities: ${event.event.value.capabilities.join(", ")}`);
          setStatus({ phase: "ready", capabilities: event.event.value.capabilities });
          void sendEvaluate(bridge);
          break;
        case "progress":
          appendLog(`progress: ${event.event.value.stage}`);
          break;
        case "completed":
          appendLog(`completed: graph_digest=${event.event.value.graphDigest}`);
          setStatus({
            phase: "completed",
            graphDigest: event.event.value.graphDigest,
            generation: event.event.value.generation.toString(),
          });
          break;
        case "failed":
          appendLog(`failed: ${event.event.value.message}`);
          setStatus({ phase: "failed", message: event.event.value.message });
          break;
        default:
          break;
      }
    });

    try {
      setStatus({ phase: "spawning" });
      appendLog(`spawning ${WORKER_PATH}`);
      await bridge.spawn(WORKER_PATH, []);
      setStatus({ phase: "awaiting_capabilities" });
      await bridge.send(
        create(WorkerRequestSchema, {
          request: { case: "hello", value: { protocolVersion: 1, capabilities: [] } },
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      appendLog(`spawn failed: ${detail}`);
      setStatus({ phase: "failed", message: String(error) });
    }

    return unsubscribe;
  }, [appendLog]);

  const sendEvaluate = useCallback(
    async (bridge: WorkerBridge) => {
      setStatus({ phase: "evaluating" });
      await bridge.send(
        create(WorkerRequestSchema, {
          request: {
            case: "evaluate",
            value: {
              sessionId: "app-spike",
              generation: 1n,
              projectRoot: REPO_ROOT,
              templateId: "machinewright.reference.simple",
              templateVersion: "1.0.0",
              inputsJson: new TextEncoder().encode(
                JSON.stringify({ requirements: { payload_kg: 10.0 } }),
              ),
              outputDirectory: "/tmp/machinewright-app-spike",
              overlays: [],
              environmentDigest: "",
            },
          },
        }),
      );
    },
    [],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Machinewright — worker bridge spike (B.1)</Text>
      <Text style={styles.status}>Status: {status.phase}</Text>
      <Text onPress={() => void runSpike()} style={styles.button}>
        Run spike
      </Text>
      <ScrollView style={styles.log}>
        {log.map((line, index) => (
          <Text key={index} style={styles.logLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

type DevToolsScreen =
  | "worker-bridge"
  | "webview-host"
  | "editor"
  | "selection-sync"
  | "gallery"
  | "performance"
  | "behavior-lab";

/**
 * Spike-only tab switch between the independent B.1-B.6 proofs, kept as one
 * screen so every spike stays reachable and independently re-verifiable
 * from a single build.
 */
function DevTools() {
  const [screen, setScreen] = useState<DevToolsScreen>("worker-bridge");

  return (
    <View style={styles.root}>
      <View style={styles.tabBar}>
        <Text
          onPress={() => setScreen("worker-bridge")}
          style={[styles.tab, screen === "worker-bridge" && styles.tabActive]}
        >
          Worker bridge (B.1)
        </Text>
        <Text
          onPress={() => setScreen("webview-host")}
          style={[styles.tab, screen === "webview-host" && styles.tabActive]}
        >
          WebView host (B.2)
        </Text>
        <Text
          onPress={() => setScreen("editor")}
          style={[styles.tab, screen === "editor" && styles.tabActive]}
        >
          Editor + LSP (B.3)
        </Text>
        <Text
          onPress={() => setScreen("selection-sync")}
          style={[styles.tab, screen === "selection-sync" && styles.tabActive]}
        >
          Selection sync (B.5)
        </Text>
        <Text
          onPress={() => setScreen("gallery")}
          style={[styles.tab, screen === "gallery" && styles.tabActive]}
        >
          Design system (B.6)
        </Text>
        <Text
          onPress={() => setScreen("performance")}
          style={[styles.tab, screen === "performance" && styles.tabActive]}
        >
          Performance (B.7)
        </Text>
        <Text
          onPress={() => setScreen("behavior-lab")}
          style={[styles.tab, screen === "behavior-lab" && styles.tabActive]}
        >
          Behavior lab (M3)
        </Text>
      </View>
      {screen === "worker-bridge" ? (
        <WorkerBridgeSpike />
      ) : screen === "webview-host" ? (
        <ViewportHost />
      ) : screen === "editor" ? (
        <EditorHost />
      ) : screen === "selection-sync" ? (
        <SelectionSyncSpike />
      ) : screen === "gallery" ? (
        <ComponentGallery />
      ) : screen === "performance" ? (
        <PerformanceSpike />
      ) : (
        <BehaviorLabSpike />
      )}
    </View>
  );
}

type Screen = "product" | "print" | "bom" | "dev-tools";

function App() {
  const [screen, setScreen] = useState<Screen>("product");

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <View style={styles.tabBar}>
          <Text
            onPress={() => setScreen("product")}
            style={[styles.tab, screen === "product" && styles.tabActive]}
          >
            Machinewright
          </Text>
          <Text
            onPress={() => setScreen("print")}
            style={[styles.tab, screen === "print" && styles.tabActive]}
          >
            3D Print
          </Text>
          <Text
            onPress={() => setScreen("bom")}
            style={[styles.tab, screen === "bom" && styles.tabActive]}
          >
            BOM
          </Text>
          {__DEV__ ? (
            <Text
              onPress={() => setScreen("dev-tools")}
              style={[styles.tab, screen === "dev-tools" && styles.tabActive]}
            >
              Dev Tools
            </Text>
          ) : null}
        </View>
        {/* Kept mounted behind Dev Tools: unmounting would drop the open project, worker session and tab state. */}
        <View style={screen === "dev-tools" ? styles.hidden : styles.shell}>
          <AppShell
            view={screen === "print" ? "print" : screen === "bom" ? "bom" : "workspace"}
            onViewChange={(view) => setScreen(view === "workspace" ? "product" : view)}
          />
        </View>
        {__DEV__ && screen === "dev-tools" ? <DevTools /> : null}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface.workspace },
  shell: { flex: 1 },
  hidden: { display: "none" },
  tabBar: {
    flexDirection: "row",
    gap: 16,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
    backgroundColor: colors.surface.panel,
  },
  tab: { fontSize: 12, color: colors.text.secondary },
  tabActive: { color: colors.accent.selection, fontWeight: "600" },
  container: { flex: 1, padding: 16, gap: 8 },
  title: { fontSize: 16, fontWeight: "600" },
  status: { fontSize: 13 },
  button: {
    fontSize: 13,
    color: colors.accent.selection,
    paddingVertical: 6,
  },
  log: { flex: 1, backgroundColor: colors.surface.display, padding: 8, borderRadius: 6 },
  logLine: { fontFamily: "Menlo", fontSize: 11, color: colors.surface.workspace },
});

export default App;
