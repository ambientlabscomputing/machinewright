/**
 * Radius, elevation, and motion tokens (RFD-19 "Surface, color, and
 * typography" / "Layout and interaction"): rounded rectangles as the basic
 * vocabulary, shallow highlights and soft shadows reserved for pressable/
 * draggable/floating surfaces, short transitions limited to communicating
 * interaction or state.
 */
export const radius = {
  none: 0,
  control: 6,
  panel: 8,
} as const;

/**
 * Elevation is expressed as shadow tokens, not a numeric z-scale — RFD-19
 * explicitly wants large panels to stay flat, with shadows reserved for
 * pressable controls, drag handles, and floating surfaces only.
 */
export const elevation = {
  flat: "none",
  control: "0 1px 2px rgba(37, 40, 45, 0.12)",
  floating: "0 4px 12px rgba(37, 40, 45, 0.18)",
} as const;

/** Short, state-communicating transitions only; honor reduced-motion. */
export const motion = {
  durationMs: {
    fast: 100,
    default: 150,
  },
  easing: "ease-out",
} as const;

export type ShapeTokens = {
  radius: typeof radius;
  elevation: typeof elevation;
  motion: typeof motion;
};
