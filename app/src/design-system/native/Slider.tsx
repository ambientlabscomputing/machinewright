/**
 * RFD-19 "Layout and interaction": "Sliders ... expose exact numeric
 * entry and keyboard operation, so their physical appearance does not
 * constrain precision or accessibility."
 *
 * This implementation covers drag interaction (via React Native's own
 * `PanResponder`, a pure-JS gesture API — no native module, consistent
 * with the DECISION.md choice to avoid new native dependencies this
 * milestone) but does NOT itself implement keyboard arrow-key stepping —
 * plain RN `View` has no reliable cross-platform focus/key-event story to
 * build that on without a native module, which is exactly the gap
 * DECISION.md names as the concrete case for a future custom Swift/AppKit
 * control. Until then, pair Slider with NumericInput bound to the same
 * value/onChange — NumericInput is a real TextInput and so is already
 * fully keyboard-operable — to satisfy the RFD requirement today.
 */
import { useRef, useState } from "react";
import { PanResponder, View, type LayoutChangeEvent } from "react-native";
import { colors } from "../tokens/colors";

export interface SliderProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
}

const TRACK_HEIGHT = 4;
const HANDLE_SIZE = 14;

export function Slider({ value, min, max, onChange, disabled = false, accessibilityLabel }: SliderProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const trackWidthRef = useRef(0);

  function onLayout(event: LayoutChangeEvent) {
    const width = event.nativeEvent.layout.width;
    trackWidthRef.current = width;
    setTrackWidth(width);
  }

  function valueFromLocalX(localX: number): number {
    const clampedX = Math.min(trackWidthRef.current, Math.max(0, localX));
    const fraction = trackWidthRef.current === 0 ? 0 : clampedX / trackWidthRef.current;
    return min + fraction * (max - min);
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: (event) => {
        setDragging(true);
        onChange(valueFromLocalX(event.nativeEvent.locationX));
      },
      onPanResponderMove: (event) => {
        onChange(valueFromLocalX(event.nativeEvent.locationX));
      },
      onPanResponderRelease: () => setDragging(false),
      onPanResponderTerminate: () => setDragging(false),
    }),
  ).current;

  const fraction = max === min ? 0 : (Math.min(max, Math.max(min, value)) - min) / (max - min);
  const handleCenter = fraction * trackWidth;

  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min, max, now: value }}
      onLayout={onLayout}
      {...panResponder.panHandlers}
      style={{ height: HANDLE_SIZE, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
    >
      <View
        style={{
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          backgroundColor: colors.border.subtle,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: "100%",
            width: `${fraction * 100}%`,
            backgroundColor: colors.accent.selection,
          }}
        />
      </View>
      <View
        style={{
          position: "absolute",
          left: Math.max(0, handleCenter - HANDLE_SIZE / 2),
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          borderRadius: HANDLE_SIZE / 2,
          backgroundColor: colors.surface.control,
          borderWidth: dragging ? 2 : 1,
          borderColor: dragging ? colors.accent.selection : colors.border.subtle,
          boxShadow: elevationForHandle(dragging),
        }}
      />
    </View>
  );
}

function elevationForHandle(dragging: boolean): string {
  return dragging ? "0 1px 2px rgba(0, 0, 0, 0.35)" : "none";
}
