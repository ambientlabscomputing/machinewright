/**
 * RFD-19 "Layout and interaction": "Sliders and any dials expose exact
 * numeric entry and keyboard operation" — this is that exact-entry
 * control: a plain, keyboard-editable numeric field with a visible unit,
 * used standalone or alongside Slider for the same value.
 */
import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { colors } from "../tokens/colors";
import { radius } from "../tokens/shape";
import { spacing } from "../tokens/spacing";
import { fontFamily, fontSize } from "../tokens/typography";
import { Text } from "./Text";

export interface NumericInputProps {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
}

export function NumericInput({
  value,
  onChange,
  unit,
  min,
  max,
  disabled = false,
  accessibilityLabel,
}: NumericInputProps) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  // Re-sync from an external value change (e.g. a paired Slider bound to
  // the same state) — but never while the field itself has focus, or an
  // in-progress edit would be overwritten out from under the typist.
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  function commit(raw: string) {
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      setText(String(value)); // reject invalid entry, restore last valid value
      return;
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    setText(String(clamped));
    onChange(clamped);
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        backgroundColor: colors.surface.control,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: focused ? colors.accent.selection : colors.border.subtle,
        paddingHorizontal: spacing.sm,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <TextInput
        value={text}
        editable={!disabled}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(text);
        }}
        onSubmitEditing={(event) => commit(event.nativeEvent.text)}
        keyboardType="numeric"
        accessibilityLabel={accessibilityLabel}
        style={{
          // A fixed width, not flex:1: this component is meant to sit
          // beside other controls in a row (e.g. paired with Slider in
          // the gallery) — flex:1 here made the *whole* NumericInput
          // greedily consume all available row width instead of sizing
          // to its actual content, starving its siblings.
          width: 64,
          fontFamily: fontFamily.mono,
          fontSize: fontSize.body,
          color: colors.text.primary,
          paddingVertical: spacing.xs,
          fontVariant: ["tabular-nums"],
        }}
      />
      {unit ? (
        <Text variant="label" tone="secondary">
          {unit}
        </Text>
      ) : null}
    </View>
  );
}
