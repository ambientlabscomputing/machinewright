//! Floem-side translation of `machinewright_ui::theme`'s framework-neutral
//! design tokens into real `floem::peniko::Color`/`f64` values. Kept as a
//! thin, exhaustive translation layer (one function per token) rather than
//! a growing pile of ad hoc helpers — every color/spacing/radius call site
//! in the adapter should go through here instead of an inline literal.

use floem::peniko::Color;
use machinewright_ui::theme::{RADIUS_MD, RADIUS_SM, color};

fn parse(hex: &str) -> Color {
    Color::parse(hex).unwrap_or(Color::BLACK)
}

pub fn surface() -> Color {
    parse(color::SURFACE)
}

pub fn surface_raised() -> Color {
    parse(color::SURFACE_RAISED)
}

pub fn ink() -> Color {
    parse(color::INK)
}

pub fn ink_muted() -> Color {
    parse(color::INK_MUTED)
}

pub fn border() -> Color {
    parse(color::BORDER)
}

pub fn accent() -> Color {
    parse(color::ACCENT)
}

pub fn accent_tint() -> Color {
    parse(color::ACCENT_TINT)
}

#[allow(dead_code)] // completes the token set; not yet consumed outside `machinewright-ui`'s own sweep chart
pub fn feasible() -> Color {
    parse(color::FEASIBLE)
}

pub fn infeasible() -> Color {
    parse(color::INFEASIBLE)
}

pub fn infeasible_tint() -> Color {
    parse(color::INFEASIBLE_TINT)
}

/// A translucent black scrim for the command-palette overlay backdrop.
/// `alpha` is 0-255, matching `Color::rgb8`/`with_alpha_factor` conventions
/// already used elsewhere in the adapter.
pub fn scrim(alpha: u8) -> Color {
    ink().multiply_alpha(alpha as f32 / 255.0)
}

pub mod space {
    #[allow(unused_imports)] // completes the scale; LG/XL not yet needed by a call site
    pub use machinewright_ui::theme::space::{LG, MD, SM, XL, XS};
}

pub const RADIUS_SM_PX: f64 = RADIUS_SM;
pub const RADIUS_MD_PX: f64 = RADIUS_MD;
pub const BORDER_WIDTH_PX: f64 = machinewright_ui::theme::BORDER_WIDTH;
