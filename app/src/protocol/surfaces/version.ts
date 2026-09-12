/**
 * Shared generation-staleness guard for WebView surface messages.
 *
 * RFD-19's "Immutable application snapshot" section requires that surface
 * messages carry generation identity so a stale event cannot select or
 * modify a newer snapshot ("reject events from older generations"). Both
 * the editor and viewport surfaces gate on this same rule; it is defined
 * once here so it is tested once, rather than reimplemented ad hoc per
 * surface (see the deleted Rust UI's review, finding R7: scattered snapshot
 * ownership let a stale event win a race).
 *
 * Evaluation `generation` is a wire uint64 (bigint, see ../worker). Document
 * versions (see editor.ts) are a separate, smaller-scoped counter and use
 * plain numbers; this guard works for either as long as both sides compare
 * the same type consistently.
 */
/** Evaluation generation identity: the wire uint64, kept as a lossless bigint. */
export type Generation = bigint;

export function isStaleGeneration<G extends bigint | number>(
  current: G,
  incoming: G,
): boolean {
  return incoming < current;
}

/** True when `incoming` is newer than `current` and should replace it. */
export function isNewerGeneration<G extends bigint | number>(
  current: G,
  incoming: G,
): boolean {
  return incoming > current;
}

export const SURFACE_PROTOCOL_VERSION = 1 as const;

/**
 * `postMessage` between RN and a WebView crosses through `JSON.stringify`/
 * `JSON.parse`, which cannot represent `bigint` at all (stringify throws).
 * Surface messages carrying a `Generation` must convert it to a decimal
 * string for the wire and back — these two functions are that boundary,
 * used by both directions (see viewport.ts's serialize/deserialize
 * helpers) so the conversion is written and tested once.
 */
export function generationToWire(generation: Generation): string {
  return generation.toString();
}

export function generationFromWire(wire: string): Generation {
  return BigInt(wire);
}
