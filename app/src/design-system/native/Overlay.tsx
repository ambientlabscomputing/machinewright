/**
 * A modal layer over the whole window: a dimming scrim that dismisses on
 * press, with its content anchored near the top and horizontally centered
 * (command-palette placement). Absolutely positioned inside the nearest
 * full-window ancestor, so mount it as the last child of the root view.
 */
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { spacing } from "../tokens/spacing";

export interface OverlayProps {
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

// A translucent black is not one of the palette's semantic colors — it only
// dims whatever surface is underneath — so it lives here, with the one
// component that needs it, rather than in the color tokens.
const SCRIM = "rgba(0, 0, 0, 0.45)";

export function Overlay({ onDismiss, children }: OverlayProps) {
  return (
    <View
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center" }}
      accessibilityViewIsModal
    >
      <Pressable
        onPress={onDismiss}
        accessibilityLabel="Dismiss"
        style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: SCRIM }}
      />
      <View style={{ marginTop: spacing.xxl * 2, width: "100%", maxWidth: 640 }}>{children}</View>
    </View>
  );
}
