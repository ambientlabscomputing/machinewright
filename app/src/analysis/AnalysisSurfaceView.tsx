/**
 * Hosts the bundled behavior-lab chart WebView (web/analysis) and
 * translates `AnalysisHostCommand`/`AnalysisSurfaceEvent` across the
 * `postMessage` boundary — the analysis-surface equivalent of
 * `viewport/ViewportHost.tsx`'s `ViewportSurfaceView`. Owns no sweep,
 * coordinator, or snapshot state; a caller (`SweepView`) drives it entirely
 * through the imperative handle and `onSurfaceEvent`.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import WebView from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { Stack, Text } from "../design-system/native";
import { getBundledAssetURL } from "../native/BundledAssets";
import {
  serializeAnalysisHostCommand,
  deserializeAnalysisSurfaceEvent,
  type AnalysisSurfaceEvent,
  type SweepPointChartDatum,
} from "../protocol/surfaces/analysis";
import type { Generation } from "../protocol/surfaces/version";

interface WebViewRefLike {
  postMessage: (message: string) => void;
}

export interface AnalysisSurfaceHandle {
  renderSweepResult(sweepId: Generation, parameterPaths: readonly string[], points: readonly SweepPointChartDatum[]): void;
  setSelectedPoint(sweepId: Generation, pointIndex: number | null): void;
  clear(): void;
}

export interface AnalysisSurfaceViewProps {
  readonly onSurfaceEvent: (event: AnalysisSurfaceEvent) => void;
}

export const AnalysisSurfaceView = forwardRef<AnalysisSurfaceHandle, AnalysisSurfaceViewProps>(
  function AnalysisSurfaceView({ onSurfaceEvent }, ref) {
    const [load, setLoad] = useState<
      { phase: "resolving" } | { phase: "ready"; url: string } | { phase: "error"; message: string }
    >({ phase: "resolving" });
    const webViewRef = useRef<WebViewRefLike>(null);

    useEffect(() => {
      let cancelled = false;
      getBundledAssetURL("web/analysis/index.html")
        .then((url) => {
          if (!cancelled) setLoad({ phase: "ready", url });
        })
        .catch((error: unknown) => {
          if (!cancelled) setLoad({ phase: "error", message: String(error) });
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const send = useCallback((command: Parameters<typeof serializeAnalysisHostCommand>[0]) => {
      webViewRef.current?.postMessage(serializeAnalysisHostCommand(command));
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        renderSweepResult: (sweepId, parameterPaths, points) =>
          send({ kind: "renderSweepResult", sweepId, parameterPaths, points }),
        setSelectedPoint: (sweepId, pointIndex) => send({ kind: "setSelectedPoint", sweepId, pointIndex }),
        clear: () => send({ kind: "clear" }),
      }),
      [send],
    );

    const onWebViewMessage = useCallback(
      (event: WebViewMessageEvent) => {
        onSurfaceEvent(deserializeAnalysisSurfaceEvent(event.nativeEvent.data));
      },
      [onSurfaceEvent],
    );

    if (load.phase === "resolving") {
      return (
        <Stack flex={1} align="center" justify="center">
          <Text>Resolving bundled asset…</Text>
        </Stack>
      );
    }
    if (load.phase === "error") {
      return (
        <Stack flex={1} align="center" justify="center">
          <Text>Failed to resolve bundled asset: {load.message}</Text>
        </Stack>
      );
    }
    return (
      <WebView
        ref={webViewRef}
        source={{ uri: load.url }}
        originWhitelist={["file://*"]}
        onMessage={onWebViewMessage}
        style={styles.webview}
      />
    );
  },
);

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
