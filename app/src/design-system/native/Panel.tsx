/**
 * A workspace surface region (RFD-19 "Layout and interaction": "navigation,
 * graph, inspectors, and diagnostics sit in aligned, resizable regions").
 * Large panels stay flat by default ("Large panels remain mostly flat so
 * dense engineering content stays legible") — `elevated` opts into the
 * shallow shadow reserved for floating surfaces.
 */
import { View, type ViewProps } from "react-native";
import { colors } from "../tokens/colors";
import { radius, elevation } from "../tokens/shape";
import { spacing, type SpacingTokens } from "../tokens/spacing";

export type PanelSurface = "workspace" | "panel" | "control" | "display";

export interface PanelProps extends Omit<ViewProps, "style"> {
  readonly surface?: PanelSurface;
  readonly padding?: keyof SpacingTokens;
  readonly elevated?: boolean;
  readonly bordered?: boolean;
  readonly flex?: number;
}

export function Panel({
  surface = "panel",
  padding = "md",
  elevated = false,
  bordered = false,
  flex,
  ...props
}: PanelProps) {
  return (
    <View
      {...props}
      style={{
        backgroundColor: colors.surface[surface],
        padding: spacing[padding],
        borderRadius: radius.panel,
        borderWidth: bordered ? 1 : 0,
        borderColor: colors.border.subtle,
        boxShadow: elevated ? elevation.floating : elevation.flat,
        flex,
      }}
    />
  );
}
