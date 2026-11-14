/**
 * The open-file tab strip above the editor. Each tab is a bordered, hoverable
 * control with an accent underline when active, a dirty dot, and its own close
 * button. Closing a tab with unsaved changes needs a second press, so edits are
 * never discarded by a stray click.
 */
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "../design-system/native";
import { colors } from "../design-system/tokens/colors";
import { radius } from "../design-system/tokens/shape";
import { spacing } from "../design-system/tokens/spacing";

export interface FileTabsProps {
  readonly documents: readonly { readonly path: string; readonly dirty: boolean }[];
  readonly activePath: string | null;
  readonly onSelect: (path: string) => void;
  readonly onClose: (path: string) => void;
}

function Tab({ path, dirty, active, onSelect, onClose }: {
  readonly path: string;
  readonly dirty: boolean;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const name = path.split("/").pop() ?? path;
  return (
    <Pressable
      onPress={onSelect}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => {
        setHovered(false);
        setConfirming(false);
      }}
      accessibilityRole="tab"
      accessibilityLabel={`${name}${dirty ? ", unsaved changes" : ""}`}
      accessibilityState={{ selected: active }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        paddingLeft: spacing.sm,
        paddingRight: spacing.xs,
        paddingVertical: spacing.xs,
        borderRadius: radius.control,
        borderWidth: 1,
        borderColor: active ? colors.border.subtle : "transparent",
        borderBottomWidth: 2,
        borderBottomColor: active ? colors.accent.selection : "transparent",
        backgroundColor: active ? colors.surface.control : hovered ? colors.surface.workspace : "transparent",
      }}
    >
      <Text variant="label" tone={active ? "primary" : "secondary"} numberOfLines={1}>
        {name}
      </Text>
      {confirming ? (
        <Text variant="label" tone="secondary">
          Discard changes?
        </Text>
      ) : null}
      <Pressable
        onPress={() => {
          if (dirty && !confirming) setConfirming(true);
          else onClose();
        }}
        onHoverIn={() => setCloseHovered(true)}
        onHoverOut={() => setCloseHovered(false)}
        accessibilityRole="button"
        accessibilityLabel={confirming ? `Discard changes and close ${name}` : `Close ${name}`}
        style={{
          width: 20,
          height: 20,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.control,
          backgroundColor: closeHovered ? colors.surface.panel : "transparent",
        }}
      >
        <Text variant="label" tone={confirming ? "action" : "secondary"}>
          {dirty && !closeHovered && !confirming ? "●" : "×"}
        </Text>
      </Pressable>
    </Pressable>
  );
}

export function FileTabs({ documents, activePath, onSelect, onClose }: FileTabsProps) {
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border.subtle, backgroundColor: colors.surface.panel }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs, padding: spacing.xs }}>
        {documents.map((document) => (
          <Tab
            key={document.path}
            path={document.path}
            dirty={document.dirty}
            active={document.path === activePath}
            onSelect={() => onSelect(document.path)}
            onClose={() => onClose(document.path)}
          />
        ))}
      </ScrollView>
    </View>
  );
}
