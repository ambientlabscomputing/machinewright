/**
 * RFD-19 "Layout and interaction" / "Surface, color, and typography": macOS
 * system sans for the shell, a bundled or system monospace for source,
 * numeric readouts, units, identifiers, and compact technical metadata, with
 * tabular figures for values that change or align in columns.
 */
export const fontFamily = {
  // "-apple-system" resolves to San Francisco on macOS in both the RN shell
  // and WebView CSS contexts.
  sans: "-apple-system, BlinkMacSystemFont, sans-serif",
  mono: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
} as const;

/** A small named scale: labels, body text, and panel headings only. */
export const fontSize = {
  label: 11,
  body: 13,
  heading: 15,
} as const;

export const fontWeight = {
  regular: "400",
  medium: "500",
  semibold: "600",
} as const;

/** Applied to monospace numeric readouts so columns of values stay aligned. */
export const numericVariant = {
  fontFeatureSettings: "'tnum' 1",
  fontVariantNumeric: "tabular-nums",
} as const;

export type TypographyTokens = {
  fontFamily: typeof fontFamily;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
};
