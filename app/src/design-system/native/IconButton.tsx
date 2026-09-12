/**
 * A single-glyph pressable action. RFD-19 "Layout and interaction":
 * "provide accessible names for icon-only actions" — `label` is required
 * and always becomes the accessibility name, never optional the way a
 * visual-only caption might be.
 */
import { useState } from "react";
import { Pressable, type PressableProps } from "react-native";
import { colors } from "../tokens/colors";
import { radius } from "../tokens/shape";
import { spacing } from "../tokens/spacing";
import { Text } from "./Text";

export interface IconButtonProps extends Omit<PressableProps, "style" | "children"> {
  /** A single glyph (from the app's one icon family, once chosen) or short symbol. */
  readonly glyph: string;
  /** Required — becomes accessibilityLabel; icon-only controls must never ship without one. */
  readonly label: string;
  readonly disabled?: boolean;
}

export function IconButton({ glyph, label, disabled = false, ...props }: IconButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      {...props}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPressIn={(event) => {
        setPressed(true);
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        props.onPressOut?.(event);
      }}
      onHoverIn={(event) => {
        setHovered(true);
        props.onHoverIn?.(event);
      }}
      onHoverOut={(event) => {
        setHovered(false);
        props.onHoverOut?.(event);
      }}
      style={{
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.control,
        backgroundColor: hovered && !disabled ? colors.surface.control : "transparent",
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        padding: spacing.xs,
      }}
    >
      <Text variant="body" tone="secondary">
        {glyph}
      </Text>
    </Pressable>
  );
}
