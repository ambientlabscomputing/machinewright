/**
 * Hosts the bundled plate viewer (web/printplan). Declarative: give it the bed
 * and the plate file to show and it keeps the WebView in sync, including
 * re-sending both after the page (re)loads.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import WebView from "react-native-webview";
import type { WebViewMessageEvent } from "react-native-webview/lib/WebViewTypes";
import { Stack, Text } from "../design-system/native";
import { colors } from "../design-system/tokens/colors";
import { getBundledAssetURL } from "../native/BundledAssets";
import {
  deserializePrintPlanSurfaceEvent,
  serializePrintPlanHostCommand,
  type PlateBed,
  type PlateViewPart,
  type PrintPlanHostCommand,
  type PrintPlanSurfaceEvent,
} from "../protocol/surfaces/printplan";

interface WebViewRefLike {
  postMessage: (message: string) => void;
  reload: () => void;
}

export interface PrintPlanSurfaceHandle {
  fitCamera(): void;
}

export interface PrintPlanSurfaceViewProps {
  readonly bed: PlateBed;
  /** File URL of the plate STL to show, or `null` for the empty bed. */
  readonly plateUrl: string | null;
  /** Changes whenever `plateUrl`'s content may have; echoed in the load events. */
  readonly plateKey: string;
  /** Parts of the shown plate, at their current positions; read whenever the plate (re)loads. */
  readonly parts: readonly PlateViewPart[];
  readonly onSurfaceEvent?: (event: PrintPlanSurfaceEvent) => void;
}

export const PrintPlanSurfaceView = forwardRef<PrintPlanSurfaceHandle, PrintPlanSurfaceViewProps>(
  function PrintPlanSurfaceView({ bed, plateUrl, plateKey, parts, onSurfaceEvent }, ref) {
    const [load, setLoad] = useState<{ phase: "resolving" } | { phase: "ready"; url: string } | { phase: "error"; message: string }>({
      phase: "resolving",
    });
    const webViewRef = useRef<WebViewRefLike>(null);
    const pageReady = useRef(false);
    const latest = useRef({ bed, plateUrl, plateKey, parts });
    latest.current = { bed, plateUrl, plateKey, parts };

    useEffect(() => {
      let cancelled = false;
      getBundledAssetURL("web/printplan/index.html")
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

    const send = useCallback((command: PrintPlanHostCommand) => {
      webViewRef.current?.postMessage(serializePrintPlanHostCommand(command));
    }, []);

    useImperativeHandle(ref, () => ({ fitCamera: () => send({ kind: "fitCamera" }) }), [send]);

    useEffect(() => {
      if (pageReady.current) send({ kind: "setBed", bed });
    }, [bed, send]);

    useEffect(() => {
      if (pageReady.current) send({ kind: "showPlate", key: plateKey, url: plateUrl, parts: latest.current.parts });
    }, [plateKey, plateUrl, send]);

    const onMessage = useCallback(
      (event: WebViewMessageEvent) => {
        const surfaceEvent = deserializePrintPlanSurfaceEvent(event.nativeEvent.data);
        if (surfaceEvent.kind === "ready") {
          pageReady.current = true;
          send({ kind: "setBed", bed: latest.current.bed });
          send({ kind: "showPlate", key: latest.current.plateKey, url: latest.current.plateUrl, parts: latest.current.parts });
        }
        onSurfaceEvent?.(surfaceEvent);
      },
      [onSurfaceEvent, send],
    );

    if (load.phase !== "ready") {
      return (
        <Stack flex={1} align="center" justify="center">
          <Text tone="secondary">{load.phase === "error" ? `Failed to load the plate viewer: ${load.message}` : "Loading plate viewer…"}</Text>
        </Stack>
      );
    }
    return (
      <WebView
        ref={webViewRef}
        source={{ uri: load.url }}
        originWhitelist={["file://*"]}
        // Plate STLs live under the project's .machinewright directory, outside the bundle;
        // XHR to them needs the same file-access prefs as the assembly viewport.
        allowingReadAccessToURL="file:///"
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={onMessage}
        onContentProcessDidTerminate={() => {
          pageReady.current = false;
          webViewRef.current?.reload();
        }}
        style={styles.webview}
      />
    );
  },
);

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: colors.surface.display },
});
