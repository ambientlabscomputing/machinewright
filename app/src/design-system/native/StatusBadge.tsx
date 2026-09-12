/**
 * RFD-19 "Surface, color, and typography": "Use separate semantic tokens
 * for success, warning, error, stale, and pending states... Status always
 * includes a label, icon, shape, or line treatment as well as color" —
 * this component is the enforcement point for that rule: it always
 * renders a text label alongside the color, so a status is never
 * conveyed by color alone.
 */
import { View } from "react-native";
import { colors } from "../tokens/colors";
import { radius } from "../tokens/shape";
import { spacing } from "../tokens/spacing";
import { Text } from "./Text";

export type StatusTone = "success" | "warning" | "error" | "stale" | "pending";

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly label: string;
}

export function StatusBadge({ tone, label }: StatusBadgeProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs / 2,
        borderRadius: radius.control,
        backgroundColor: colors.surface.control,
        alignSelf: "flex-start",
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: colors.status[tone],
        }}
      />
      <Text variant="label" tone="secondary">
        {label}
      </Text>
    </View>
  );
}
