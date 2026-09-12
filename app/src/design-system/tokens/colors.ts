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
  surface: {
    workspace: "#E8E9EB",
    panel: "#F4F4F2",
    control: "#FAFAF8",
    display: "#202329",
  },
  text: {
    primary: "#25282D",
    secondary: "#5D626A",
  },
  border: {
    subtle: "#C8CBD0",
  },
  accent: {
    action: "#F65B24",
    selection: "#007EA8",
  },
  // PLACEHOLDER — RFD-19 requires these be distinct semantic tokens but does
  // not specify literal values; do not ship without design sign-off.
  status: {
    success: "#2E7D4F",
    warning: "#B26A00",
    error: "#B3261E",
    stale: "#8A8F98",
    pending: "#5D626A",
  },
} as const;

export type ColorTokens = typeof colors;
