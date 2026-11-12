/**
 * A single-line text entry control (command palette query, prompts). Like
 * every primitive it takes no `style`: appearance comes from tokens only.
 * Focus is shown with the selection accent, matching `NumericInput`.
 */
import { useState } from "react";
import { TextInput } from "react-native";
import { colors } from "../tokens/colors";
import { radius } from "../tokens/shape";
import { spacing } from "../tokens/spacing";
import { fontFamily, fontSize } from "../tokens/typography";

export interface TextFieldProps {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  readonly monospace?: boolean;
  readonly accessibilityLabel: string;
}

export function TextField({
  value,
  onChangeText,
  onSubmit,
  placeholder,
  autoFocus = false,
  monospace = false,
  accessibilityLabel,
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onSubmitEditing={(event) => onSubmit?.(event.nativeEvent.text)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      placeholderTextColor={colors.text.secondary}
      autoFocus={autoFocus}
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      accessibilityLabel={accessibilityLabel}
      style={{
        fontFamily: monospace ? fontFamily.mono : fontFamily.sans,
        fontSize: fontSize.body,
        color: colors.text.primary,
        backgroundColor: colors.surface.control,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: focused ? colors.accent.selection : colors.border.subtle,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
      }}
    />
  );
}
