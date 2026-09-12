/**
 * The primary pressable control (RFD-19 "Layout and interaction":
 * "A button may gain a shallow edge on hover and lose elevation when
 * pressed... Disabled and read-only states remain understandable").
 * `tone="action"` is the sparing orange emphasis reserved for the primary
 * command (RFD-19 "Surface, color, and typography": "Reserve ...
 * accent.action for the primary command or active parameter").
 */
import { useState } from "react";
import { Pressable, type PressableProps } from "react-native";
import { colors } from "../tokens/colors";
import { radius } from "../tokens/shape";
import { spacing } from "../tokens/spacing";
import { Text } from "./Text";

export type ButtonTone = "neutral" | "action";
export type ButtonSize = "compact" | "default";

export interface ButtonProps extends Omit<PressableProps, "style" | "children"> {
  readonly label: string;
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
}

const TONE_BACKGROUND: Record<ButtonTone, string> = {
  neutral: colors.surface.control,
  action: colors.accent.action,
};

const TONE_TEXT_TONE: Record<ButtonTone, "primary" | "inverse"> = {
  neutral: "primary",
  action: "inverse",
};

export function Button({ label, tone = "neutral", size = "default", disabled = false, ...props }: ButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      {...props}
      disabled={disabled}
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
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={{
        backgroundColor: TONE_BACKGROUND[tone],
        paddingHorizontal: spacing[size === "compact" ? "sm" : "md"],
        paddingVertical: spacing[size === "compact" ? "xs" : "sm"],
        borderRadius: radius.control,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        // "A shallow edge on hover" — a border only appears on hover, not
        // a shadow (RFD: shadows are reserved for pressable/draggable/
        // floating surfaces broadly, but large flat panels stay boundary-
        // free; a hover border is the intentionally restrained version
        // for a compact control like a button).
        borderWidth: 1,
        borderColor: hovered && !disabled ? colors.border.subtle : "transparent",
        // React Native's View style has no transition support (unlike the
        // WebView surfaces' CSS) — RFD-19's "keep transitions short" motion
        // tokens apply there, not here; this state change is instant.
      }}
    >
      <Text variant="label" tone={TONE_TEXT_TONE[tone]}>
        {label}
      </Text>
    </Pressable>
  );
}
