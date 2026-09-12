//! Toolbar grid structure: a thin hairline divider used to break a row of
//! buttons into logical clusters. This is the concrete mechanism behind
//! "grid and implied grids gracefully broken by a sparing accent" — a
//! toolbar reads as *segments* the eye can group, not one undifferentiated
//! row, and it's what makes a single accent-colored button stand out
//! rather than getting lost among a dozen equally-weighted siblings.

use floem::IntoView;
use floem::views::{Decorators, empty};

use crate::theme;

/// A thin vertical rule separating two toolbar clusters. Fixed height
/// (matches a button's typical content height) so it reads as a rule
/// alongside text/buttons rather than stretching to fill the row.
pub fn toolbar_divider() -> impl IntoView {
    empty().style(|style| {
        style
            .width(theme::BORDER_WIDTH_PX)
            .height(20.0)
            .margin_horiz(theme::space::XS)
            .background(theme::border())
    })
}
