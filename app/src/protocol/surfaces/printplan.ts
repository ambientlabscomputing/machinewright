/**
 * Messages between the RN shell and the bundled three.js plate viewer
 * (web/printplan): a print bed with one generated plate STL on it.
 *
 * Unlike the assembly viewport there is no prepare/commit staging: a plate is
 * a single file, so `showPlate` simply replaces the current one. `key` is an
 * opaque token the shell chooses (it changes whenever the file's content may
 * have), echoed back in the load events so a slow load of a superseded plate is
 * ignored by the shell.
 */

export interface PlateBed {
  readonly bedX: number;
  readonly bedY: number;
  readonly maxZ: number;
  /** Where the plate STL's coordinate origin sits on the bed. */
  readonly origin: "corner" | "center";
  /** Unprintable border (mm); dragged parts are kept inside it. */
  readonly margin: number;
}

/**
 * One part of the plate being shown. `x`/`y` (footprint lower-left corner, mm from the bed's
 * front-left corner, as in the print plan) are where it sits now; `originX`/`originY` are where
 * it sits in the STL file, which is how the viewer tells which triangles belong to it.
 */
export interface PlateViewPart {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly depth: number;
}

export type PrintPlanHostCommand =
  | { readonly kind: "setBed"; readonly bed: PlateBed }
  /** Shows the STL at `url` (bed coordinates, mm) on the bed; `url: null` shows the empty bed. */
  | { readonly kind: "showPlate"; readonly key: string; readonly url: string | null; readonly parts: readonly PlateViewPart[] }
  | { readonly kind: "fitCamera" };

export type PrintPlanSurfaceEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "plateLoaded"; readonly key: string }
  | { readonly kind: "plateFailed"; readonly key: string; readonly reason: string }
  /** The user dropped a part at a new place (same coordinates as `PlateViewPart.x/y`). */
  | { readonly kind: "partMoved"; readonly key: string; readonly id: string; readonly x: number; readonly y: number };

export function serializePrintPlanHostCommand(command: PrintPlanHostCommand): string {
  return JSON.stringify(command);
}

export function deserializePrintPlanHostCommand(json: string): PrintPlanHostCommand {
  return JSON.parse(json) as PrintPlanHostCommand;
}

export function serializePrintPlanSurfaceEvent(event: PrintPlanSurfaceEvent): string {
  return JSON.stringify(event);
}

export function deserializePrintPlanSurfaceEvent(json: string): PrintPlanSurfaceEvent {
  return JSON.parse(json) as PrintPlanSurfaceEvent;
}
