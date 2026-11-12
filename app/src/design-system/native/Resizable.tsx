/**
 * A panel with one draggable edge (RFD-19 "Layout and interaction":
 * "navigation, graph, inspectors, and diagnostics sit in aligned, resizable
 * regions around them"). Wraps its child at a controlled pixel size and
 * exposes a thin drag handle on the selected edge that reports the new
 * size — the caller owns the size as ordinary state, this component never
 * owns layout state of its own.
 *
 * This is the "narrow, documented layout API" RFD-19's design-language
 * enforcement calls for as the one acceptable place measured dimensions
 * live outside the token scale ("Any measured dimensions required for
 * resizing, virtualization, or canvas placement belong to a narrow,
 * documented layout API"): `size`/`onResize` are plain numbers because a
 * resizable pixel width has no sensible token, not because this component
 * is a general style escape hatch — it takes no `style` prop, matching
 * every other design-system primitive.
 */
import { useMemo, useRef } from "react";
import { PanResponder, View, type PanResponderGestureState } from "react-native";
import { colors } from "../tokens/colors";

const HANDLE_THICKNESS = 6;

export type ResizeEdge = "left" | "right" | "bottom" | "top";

export interface ResizableProps {
  readonly size: number;
  readonly onResize: (nextSize: number) => void;
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly edge: ResizeEdge;
  /**
   * Hides the panel (zero size, no handle) while keeping `children` mounted,
   * so stateful content (a terminal session) survives being toggled away.
   */
  readonly collapsed?: boolean;
  readonly children?: React.ReactNode;
}

export function Resizable({ size, onResize, minSize = 120, maxSize = 900, edge, collapsed = false, children }: ResizableProps) {
  // `PanResponderGestureState.dx`/`dy` are already cumulative deltas from
  // gesture start (not from the previous move event), so the only state
  // this needs to capture at grant time is the size the drag started from.
  const startSize = useRef(size);
  const horizontal = edge === "left" || edge === "right";
  // Dragging toward the panel's interior grows it: leftward for a left handle, upward for a top handle.
  const inverted = edge === "left" || edge === "top";

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          startSize.current = size;
        },
        onPanResponderMove: (_event, gesture: PanResponderGestureState) => {
          const delta = horizontal ? gesture.dx : gesture.dy;
          const next = Math.min(maxSize, Math.max(minSize, startSize.current + (inverted ? -delta : delta)));
          onResize(next);
        },
      }),
    // Recreated whenever these change so every callback closes over the
    // latest render's values rather than a stale one from responder-creation time.
    [inverted, horizontal, size, onResize, minSize, maxSize],
  );

  return (
    <View
      style={[
        horizontal
          ? { width: collapsed ? 0 : size, flexDirection: edge === "left" ? "row-reverse" : "row" }
          : { height: collapsed ? 0 : size, flexDirection: edge === "top" ? "column-reverse" : "column" },
        collapsed ? { overflow: "hidden" } : null,
      ]}
    >
      <View style={{ flex: 1 }}>{children}</View>
      {collapsed ? null : (
        <View
          {...responder.panHandlers}
          style={
            horizontal
              ? { width: HANDLE_THICKNESS, backgroundColor: colors.border.subtle }
              : { height: HANDLE_THICKNESS, backgroundColor: colors.border.subtle }
          }
        />
      )}
    </View>
  );
}
