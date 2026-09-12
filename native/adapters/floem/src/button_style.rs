//! A small button-variant system so every button in the app draws from one
//! consistent set of styles instead of the previous default: ~41 rendered
//! buttons, of which only one had any styling at all. Each call site's diff
//! is one `.variant(...)` suffix; the actual style values live once, here.

use floem::peniko::Color;
use floem::style::Style;
use floem::views::Decorators;

use crate::theme;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonVariant {
    /// The one primary action of whatever's currently visible — never more
    /// than one `Primary` button on screen at a time, or the accent stops
    /// meaning anything (e.g. the header's `Primary` is Evaluate alone;
    /// Save/Force Save are `Secondary` even though they're common, because
    /// they aren't *the* action this screen exists to trigger). Examples:
    /// Evaluate, Run Sweep, Trust and Run, each form's own Confirm/Go.
    Primary,
    /// Everything else that isn't primary or destructive: Reload, Compare,
    /// Undo/Redo, Confirm/Replace All/Go, Apply.
    Secondary,
    /// Cancel/close/destructive actions: Cancel, close-tab, cancel
    /// measurement.
    Destructive,
    /// Low-emphasis toggles: dock tabs, Rename/Find-Replace/Go-to-Line/
    /// Measure toggles. No border, background only while active/hovered.
    Ghost,
    /// Compact toolbar controls: the viewport's camera/section buttons,
    /// Retry Worker, sweep A/B markers.
    Icon,
}

/// Applies `variant`'s base look to `style`. Exposed (not just the
/// extension trait below) so call sites with pre-existing conditional
/// styling (the dock-tab and file-tab active-state closures) can layer
/// their own state on top via `Style::apply`.
pub fn apply_variant(style: Style, variant: ButtonVariant) -> Style {
    let padded = |style: Style, horiz: f64| {
        style
            .border_radius(theme::RADIUS_SM_PX)
            .padding_horiz(horiz)
            .padding_vert(theme::space::XS)
    };
    match variant {
        ButtonVariant::Primary => padded(style, theme::space::SM)
            .border(theme::BORDER_WIDTH_PX)
            .background(theme::accent())
            .border_color(theme::accent())
            .color(Color::WHITE)
            .hover(|s| s.background(theme::accent().multiply_alpha(0.85))),
        ButtonVariant::Secondary => padded(style, theme::space::SM)
            .border(theme::BORDER_WIDTH_PX)
            .background(theme::surface_raised())
            .border_color(theme::border())
            .color(theme::ink())
            .hover(|s| s.background(theme::surface())),
        ButtonVariant::Destructive => padded(style, theme::space::SM)
            .border(theme::BORDER_WIDTH_PX)
            .background(theme::surface_raised())
            .border_color(theme::infeasible())
            .color(theme::infeasible())
            .hover(|s| s.background(theme::infeasible_tint())),
        ButtonVariant::Ghost => padded(style, theme::space::SM)
            .border(0.0)
            .background(Color::TRANSPARENT)
            .color(theme::ink_muted())
            .hover(|s| s.background(theme::surface())),
        ButtonVariant::Icon => padded(style, theme::space::XS)
            .border(0.0)
            .background(Color::TRANSPARENT)
            .color(theme::ink_muted())
            .hover(|s| s.background(theme::surface())),
    }
}

pub trait ButtonVariantExt: Decorators {
    fn variant(self, variant: ButtonVariant) -> Self::DV {
        self.style(move |s| apply_variant(s, variant))
    }
}

impl<T: Decorators> ButtonVariantExt for T {}
