/**
 * 4-point spacing scale (RFD-19 "Layout and interaction": "Use a 4-point
 * spacing base with named spacing tokens and consistent row heights").
 */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Consistent row heights for dense inspector/list content. */
export const rowHeight = {
  compact: 24,
  default: 28,
  comfortable: 36,
} as const;

export type SpacingTokens = typeof spacing;
