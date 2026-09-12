/**
 * The native design system's Text primitive (RFD-19 "Enforcing the design
 * language": feature modules select named variants instead of overriding
 * internal styles). No `style` prop — every visual choice is a named
 * `variant`/`tone`, so a raw color or font size literal can never enter
 * through this component (scripts/check-boundaries.mjs also statically
 * rejects raw color literals outside design-system/tokens, but a missing
 * escape hatch is the stronger guarantee).
 */
import { Text as RNText, type TextProps as RNTextProps } from "react-native";
import { colors } from "../tokens/colors";
import { fontFamily, fontSize, fontWeight } from "../tokens/typography";

export type TextVariant = "body" | "label" | "heading" | "mono";
export type TextTone = "primary" | "secondary" | "action" | "selection" | "inverse";

export interface TextProps extends Omit<RNTextProps, "style"> {
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  /** Tabular figures for values that change or align in columns (RFD-19 "Surface, color, and typography"). */
  readonly numeric?: boolean;
}

const TONE_COLOR: Record<TextTone, string> = {
  primary: colors.text.primary,
  secondary: colors.text.secondary,
  action: colors.accent.action,
  selection: colors.accent.selection,
  inverse: colors.surface.workspace,
};

// No explicit value type here: it must stay exactly what the token
// objects infer (fontWeight as its literal "400"/"500"/"600", not
// widened to `string`) to satisfy React Native's TextStyle.
const VARIANT_FONT = {
  body: { fontFamily: fontFamily.sans, fontSize: fontSize.body, fontWeight: fontWeight.regular },
  label: { fontFamily: fontFamily.sans, fontSize: fontSize.label, fontWeight: fontWeight.medium },
  heading: { fontFamily: fontFamily.sans, fontSize: fontSize.heading, fontWeight: fontWeight.semibold },
  mono: { fontFamily: fontFamily.mono, fontSize: fontSize.body, fontWeight: fontWeight.regular },
};

export function Text({ variant = "body", tone = "primary", numeric = false, ...props }: TextProps) {
  return (
    <RNText
      {...props}
      style={[
        VARIANT_FONT[variant],
        { color: TONE_COLOR[tone] },
        // React Native's tabular-figure support is the `fontVariant` array
        // prop, not the CSS `font-variant-numeric`/`font-feature-settings`
        // properties the shared tokens/typography.ts `numericVariant`
        // constant uses for the WebView surfaces — the two runtimes need
        // different shapes for the same semantic token, so this is
        // deliberately not `numericVariant` reused directly.
        numeric ? { fontVariant: ["tabular-nums" as const] } : null,
      ]}
    />
  );
}
