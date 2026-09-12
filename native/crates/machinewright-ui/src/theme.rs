//! Framework-neutral design tokens: plain hex-string colors and numeric
//! scales, no Floem/peniko types. This crate has zero Floem dependency by
//! convention (see the crate root doc comment) so that a future adapter
//! could reuse the same tokens; `Style`/`Color` construction from these
//! values is the Floem adapter's job (`native/adapters/floem/src/theme.rs`).
//!
//! Direction: a "teenage engineering"-like language — a handful of neutral
//! surfaces plus one sparing accent color, a small strictly-increasing
//! spacing scale, and one border/radius scale, applied consistently instead
//! of ad hoc per-widget literals.

pub mod color {
    /// Near-white neutral background — replaces the app's previous mix of
    /// unrelated blue-tinted grays for sidebar/dock-header chrome.
    pub const SURFACE: &str = "#F7F6F3";
    /// Raised surfaces (cards, the command palette panel).
    pub const SURFACE_RAISED: &str = "#FFFFFF";
    /// Primary text and structural strokes.
    pub const INK: &str = "#1C1B1A";
    /// Secondary/muted text.
    pub const INK_MUTED: &str = "#6B6862";
    /// Hairline borders delineating zones (the "implied grid").
    pub const BORDER: &str = "#D8D5CE";
    /// The one sparing accent: primary actions, the active dock tab.
    pub const ACCENT: &str = "#FF5A1F";
    /// A light tint of `ACCENT`, for e.g. a selected row.
    pub const ACCENT_TINT: &str = "#FFE8DC";
    /// Semantic feasibility colors — reused verbatim from the sweep plot's
    /// existing `FEASIBLE_COLOR`/`INFEASIBLE_COLOR` (see `sweep.rs`), since
    /// they're already load-bearing elsewhere and shouldn't casually change.
    pub const FEASIBLE: &str = "#16a34a";
    pub const INFEASIBLE: &str = "#dc2626";
    /// A light tint of `INFEASIBLE`, for error/warning backgrounds.
    pub const INFEASIBLE_TINT: &str = "#FDEBEA";
}

/// A small spacing scale — a strict superset of the values already
/// scattered through the adapter today (4/6/8/10/12), so migrating existing
/// call sites is a mechanical round-to-nearest, not a redesign.
pub mod space {
    pub const XS: f64 = 4.0;
    pub const SM: f64 = 8.0;
    pub const MD: f64 = 12.0;
    pub const LG: f64 = 16.0;
    pub const XL: f64 = 24.0;
}

pub const RADIUS_SM: f64 = 4.0;
pub const RADIUS_MD: f64 = 8.0;
pub const BORDER_WIDTH: f64 = 1.0;

#[cfg(test)]
mod tests {
    use super::*;

    fn is_hex_color(value: &str) -> bool {
        value.len() == 7
            && value.starts_with('#')
            && value[1..].chars().all(|c| c.is_ascii_hexdigit())
    }

    #[test]
    fn every_color_token_is_a_valid_hex_literal() {
        for token in [
            color::SURFACE,
            color::SURFACE_RAISED,
            color::INK,
            color::INK_MUTED,
            color::BORDER,
            color::ACCENT,
            color::ACCENT_TINT,
            color::FEASIBLE,
            color::INFEASIBLE,
            color::INFEASIBLE_TINT,
        ] {
            assert!(is_hex_color(token), "not a valid #RRGGBB literal: {token}");
        }
    }

    #[test]
    fn spacing_scale_is_strictly_increasing() {
        let scale = [space::XS, space::SM, space::MD, space::LG, space::XL];
        for pair in scale.windows(2) {
            assert!(
                pair[0] < pair[1],
                "spacing scale is not strictly increasing: {scale:?}"
            );
        }
    }

    #[test]
    fn radius_scale_is_strictly_increasing() {
        const { assert!(RADIUS_SM < RADIUS_MD) };
    }
}
