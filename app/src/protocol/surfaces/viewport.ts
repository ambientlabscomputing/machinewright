/**
 * Versioned messages between the RN/TS application shell and the bundled
 * three.js WebView surface (RFD-19 "3D viewport" section).
 *
 * Implements the "Immutable application snapshot" prepare/ready/commit
 * exchange (RFD-19 lines ~488-494): a new generation's geometry is staged
 * in the WebView (`prepareSnapshot`) and only presented once the WebView
 * acknowledges it is ready (`prepared`); the host then promotes it
 * (`commitSnapshot`). Until commit, the WebView keeps showing the last
 * committed generation. This directly targets the deleted Rust UI's R7
 * finding (snapshot installation had multiple owners and reset view state
 * as a side effect) by making promotion a single explicit two-phase
 * exchange instead of an implicit consequence of a successful evaluation.
 *
 * Large geometry never crosses this channel: commands carry only digests
 * and manifest metadata into the content-addressed artifact cache (RFD
 * line ~436, "not base64 meshes or per-frame geometry"); the WebView loads
 * mesh bytes itself via the scoped local artifact-cache URL scheme.
 */

import { type Generation, generationToWire, generationFromWire } from "./version";

export interface MeshRefLite {
  readonly graphNodeId: string;
  readonly digest: string;
  /** Scoped local resource URL into the content-addressed artifact cache. */
  readonly url: string;
}

/** Commands the application shell sends into the viewport WebView. */
export type ViewportHostCommand =
  | {
      readonly kind: "prepareSnapshot";
      readonly generation: Generation;
      readonly artifactManifestDigest: string;
      readonly meshes: readonly MeshRefLite[];
    }
  | { readonly kind: "commitSnapshot"; readonly generation: Generation }
  | { readonly kind: "discardSnapshot"; readonly generation: Generation }
  | {
      readonly kind: "setSelection";
      readonly generation: Generation;
      readonly nodeIds: readonly string[];
      readonly primaryNodeId: string | null;
    }
  | { readonly kind: "fitCamera" }
  /**
   * B.7 performance-spike only: installs a procedurally generated mesh of
   * exactly `triangleCount` triangles directly into the scene, bypassing
   * the prepare/commit staging path entirely (there is no real generation
   * or worker evaluation behind a synthetic benchmark mesh). Not part of
   * the product surface — exists only so frame-rate can be *measured*
   * against RFD-19's "Responsiveness and resource budgets" requirement
   * instead of assumed.
   */
  | { readonly kind: "benchmarkSynthetic"; readonly triangleCount: number };

/** Events the viewport WebView emits back to the application shell. */
export type ViewportSurfaceEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "prepared"; readonly generation: Generation }
  | {
      readonly kind: "prepareFailed";
      readonly generation: Generation;
      readonly reason: string;
    }
  | {
      readonly kind: "pickResult";
      readonly generation: Generation;
      readonly graphNodeId: string | null;
      readonly geometryEntityId: string | null;
    }
  | { readonly kind: "contextLost" }
  | { readonly kind: "contextRestored" }
  | {
      readonly kind: "benchmarkResult";
      readonly triangleCount: number;
      readonly fps: number;
      readonly frames: number;
      readonly durationMs: number;
    };

/**
 * `JSON.stringify` throws on `bigint`, so a `Generation` field must become
 * a decimal string for the actual `postMessage` wire and be converted
 * back on receipt — these four functions are that boundary for
 * ViewportHostCommand/ViewportSurfaceEvent specifically (see
 * version.ts's generationToWire/generationFromWire for the primitive).
 * Both RN (ViewportHost.tsx) and the WebView bundle (web/viewport/src/
 * main.ts) use these rather than calling JSON.stringify/parse directly.
 */
function hostCommandHasGeneration(
  command: ViewportHostCommand,
): command is Exclude<ViewportHostCommand, { kind: "fitCamera" } | { kind: "benchmarkSynthetic" }> {
  return command.kind !== "fitCamera" && command.kind !== "benchmarkSynthetic";
}

function surfaceEventHasGeneration(
  event: ViewportSurfaceEvent,
): event is Exclude<
  ViewportSurfaceEvent,
  { kind: "ready" } | { kind: "contextLost" } | { kind: "contextRestored" } | { kind: "benchmarkResult" }
> {
  return (
    event.kind !== "ready" &&
    event.kind !== "contextLost" &&
    event.kind !== "contextRestored" &&
    event.kind !== "benchmarkResult"
  );
}

export function serializeViewportHostCommand(command: ViewportHostCommand): string {
  if (!hostCommandHasGeneration(command)) return JSON.stringify(command);
  return JSON.stringify({ ...command, generation: generationToWire(command.generation) });
}

export function deserializeViewportHostCommand(json: string): ViewportHostCommand {
  const parsed = JSON.parse(json) as ViewportHostCommand;
  if (!hostCommandHasGeneration(parsed)) return parsed;
  return {
    ...parsed,
    generation: generationFromWire(parsed.generation as unknown as string),
  };
}

export function serializeViewportSurfaceEvent(event: ViewportSurfaceEvent): string {
  if (!surfaceEventHasGeneration(event)) return JSON.stringify(event);
  return JSON.stringify({ ...event, generation: generationToWire(event.generation) });
}

export function deserializeViewportSurfaceEvent(json: string): ViewportSurfaceEvent {
  const parsed = JSON.parse(json) as ViewportSurfaceEvent;
  if (!surfaceEventHasGeneration(parsed)) return parsed;
  return {
    ...parsed,
    generation: generationFromWire(parsed.generation as unknown as string),
  };
}
