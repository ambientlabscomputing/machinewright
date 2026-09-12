/**
 * Layout primitive (RFD-19 "Enforcing the design language": "Layout is
 * composed with approved layout primitives and token-valued props").
 * Deliberately has no `style` prop — RFD-19 explicitly allows "structural
 * values such as flex factors" as tokens don't cover everything layout
 * needs, so `flex` is a named prop rather than an escape hatch into
 * arbitrary styling.
 */
import { View, type ViewProps } from "react-native";
import { spacing, type SpacingTokens } from "../tokens/spacing";

export interface StackProps extends Omit<ViewProps, "style"> {
  readonly direction?: "row" | "column";
  readonly gap?: keyof SpacingTokens;
  readonly align?: "flex-start" | "center" | "flex-end" | "stretch";
  readonly justify?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around";
  readonly flex?: number;
  readonly wrap?: boolean;
}

export function Stack({
  direction = "column",
  gap = "none",
  align,
  justify,
  flex,
  wrap = false,
  ...props
}: StackProps) {
  return (
    <View
      {...props}
      style={{
        flexDirection: direction,
        gap: spacing[gap],
        alignItems: align,
        justifyContent: justify,
        flex,
        flexWrap: wrap ? "wrap" : "nowrap",
      }}
    />
  );
}
