/**
 * Semantic color tokens (RFD-19 "Surface, color, and typography").
 *
 * These are a design *starting point*, subject to contrast validation in
 * the component gallery (B.6) — not final values. Feature code must never
 * import raw hex literals; it consumes these semantic names (enforced by
 * the token-literal lint rule once design-system/native and web/design-system
 * exist to check against).
 *
 * The success/warning/error/stale/pending status tokens the RFD calls for
 * ("Use separate semantic tokens for success, warning, error, stale, and
 * pending states") have no literal values in the RFD itself — placeholders
 * below are marked accordingly and need product/design sign-off before
 * they're treated as final, distinct from the "starting point, pending
 * contrast validation" caveat that applies to every other token here.
 */
export const colors = {
  // Dark theme: a deep carbon base with soft, low-contrast neutrals.
  // Neutrals are never pure black/white; hue stays slightly cool.
  surface: {
    workspace: "#16181B",
    panel: "#1D2024",
    control: "#262A30",
    display: "#111315",
  },
  text: {
    primary: "#D4D7DB",
    secondary: "#8C929A",
  },
  border: {
    subtle: "#363B42",
  },
  // Highlight palette is restricted to: copper, PCB green, caution yellow,
  // alarm red, and Cherenkov radiation blue.
  accent: {
    action: "#D17F4B", // copper
    selection: "#5BB4FF", // Cherenkov blue
  },
  status: {
    success: "#3FA46E", // PCB green
    warning: "#F0C02E", // caution yellow
    error: "#E5484D", // alarm red
    stale: "#6E747C",
    pending: "#8C929A",
  },
} as const;

export type ColorTokens = typeof colors;
