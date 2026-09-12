/**
 * Labels a control for dense inspector-row layouts (RFD-19 "Layout and
 * interaction": "Dense views should retain clear alignment of labels,
 * values, units, and actions").
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { spacing } from "../tokens/spacing";
import { Text } from "./Text";

export interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly hint?: string;
}

export function Field({ label, children, hint }: FieldProps) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text variant="label" tone="secondary">
        {label}
      </Text>
      {children}
      {hint ? (
        <Text variant="label" tone="secondary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
