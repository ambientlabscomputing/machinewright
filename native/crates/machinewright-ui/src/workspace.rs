//! Framework-neutral workspace layout: which panel is visible in which
//! dock zone. This extends the crate's ViewModel/Intent/reduce convention
//! (see `graph`, `controls`, `sweep`) from a single panel's content up to
//! *arrangement* — which panels exist, which dock zone hosts each one by
//! default, which tab within a zone is active, and whether a zone is
//! collapsed. How a user actually resizes or drags a divider is real
//! interaction code and stays adapter-side; this module only owns the
//! state that interaction mutates.
//!
//! Pattern: fixed Center (Editor + Viewport, not part of this model) plus
//! Left/Right/Bottom dock zones, each able to host several panels as tabs
//! — the same shape Zed and VS Code use, and the one named in RFD-19's own
//! reference to Zed/GPUI. Left starts empty (reserved for a future panel,
//! e.g. an M5 Evidence view) and isn't rendered until it has one.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelId {
    Graph,
    Diagnostics,
    Controls,
    Sweep,
}

impl PanelId {
    pub fn title(&self) -> &'static str {
        match self {
            PanelId::Graph => "Graph",
            PanelId::Diagnostics => "Diagnostics",
            PanelId::Controls => "Controls",
            PanelId::Sweep => "Sweep",
        }
    }
}

impl fmt::Display for PanelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.title())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dock {
    Left,
    Right,
    Bottom,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DockZone {
    /// Tab order. Empty means the zone renders nothing (no header, no
    /// content) — that's the Left zone's starting state in v1.
    pub panels: Vec<PanelId>,
    pub active: Option<PanelId>,
    pub collapsed: bool,
}

impl DockZone {
    fn hosting(panels: Vec<PanelId>) -> Self {
        let active = panels.first().copied();
        Self {
            panels,
            active,
            collapsed: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceLayout {
    pub left: DockZone,
    pub right: DockZone,
    pub bottom: DockZone,
}

impl WorkspaceLayout {
    /// Graph and Diagnostics on the right (today's `sidebar`, split into
    /// two tabs instead of one un-scrolled column); Controls and Sweep on
    /// the bottom (the Behavior Lab, as tabs instead of a fixed
    /// side-by-side row — using less space, not more, since only one
    /// shows at a time); nothing on the left yet.
    pub fn default_for_machinewright() -> Self {
        Self {
            left: DockZone::default(),
            right: DockZone::hosting(vec![PanelId::Graph, PanelId::Diagnostics]),
            bottom: DockZone::hosting(vec![PanelId::Controls, PanelId::Sweep]),
        }
    }

    fn dock_mut(&mut self, dock: Dock) -> &mut DockZone {
        match dock {
            Dock::Left => &mut self.left,
            Dock::Right => &mut self.right,
            Dock::Bottom => &mut self.bottom,
        }
    }

    fn zone_hosting_mut(&mut self, panel: PanelId) -> Option<&mut DockZone> {
        [&mut self.left, &mut self.right, &mut self.bottom]
            .into_iter()
            .find(|zone| zone.panels.contains(&panel))
    }

    pub fn dock(&self, dock: Dock) -> &DockZone {
        match dock {
            Dock::Left => &self.left,
            Dock::Right => &self.right,
            Dock::Bottom => &self.bottom,
        }
    }

    /// The zone hosting `panel`, if any — the adapter's rendering side
    /// uses this to decide whether a given panel's view should currently
    /// be visible (it is iff this zone's `active` is `Some(panel)` and
    /// it isn't `collapsed`).
    pub fn zone_hosting(&self, panel: PanelId) -> Option<&DockZone> {
        [&self.left, &self.right, &self.bottom]
            .into_iter()
            .find(|zone| zone.panels.contains(&panel))
    }

    /// Whether `panel`'s content should currently be rendered visible:
    /// it's the active tab of the zone hosting it, and that zone isn't
    /// collapsed. `false` for a panel hosted nowhere.
    pub fn is_visible(&self, panel: PanelId) -> bool {
        self.zone_hosting(panel)
            .is_some_and(|zone| !zone.collapsed && zone.active == Some(panel))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceIntent {
    /// Switches the active tab within whichever zone hosts `panel` — a
    /// no-op if no zone hosts it (e.g. a stale `PanelId` from a future
    /// layout).
    ActivatePanel(PanelId),
    ToggleCollapsed(Dock),
}

/// Applies one workspace intent, returning the updated layout. Pure: never
/// touches any other zone than the one the intent names.
pub fn reduce_workspace_intent(
    layout: &WorkspaceLayout,
    intent: WorkspaceIntent,
) -> WorkspaceLayout {
    let mut layout = layout.clone();
    match intent {
        WorkspaceIntent::ActivatePanel(panel) => {
            if let Some(zone) = layout.zone_hosting_mut(panel) {
                zone.active = Some(panel);
            }
        }
        WorkspaceIntent::ToggleCollapsed(dock) => {
            let zone = layout.dock_mut(dock);
            zone.collapsed = !zone.collapsed;
        }
    }
    layout
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_layout_assigns_the_intended_panels_per_zone() {
        let layout = WorkspaceLayout::default_for_machinewright();
        assert_eq!(
            layout.right.panels,
            vec![PanelId::Graph, PanelId::Diagnostics]
        );
        assert_eq!(layout.right.active, Some(PanelId::Graph));
        assert_eq!(
            layout.bottom.panels,
            vec![PanelId::Controls, PanelId::Sweep]
        );
        assert_eq!(layout.bottom.active, Some(PanelId::Controls));
        assert!(layout.left.panels.is_empty());
        assert!(!layout.right.collapsed);
        assert!(!layout.bottom.collapsed);
    }

    #[test]
    fn activate_panel_switches_the_correct_zone_only() {
        let layout = WorkspaceLayout::default_for_machinewright();
        let updated = reduce_workspace_intent(
            &layout,
            WorkspaceIntent::ActivatePanel(PanelId::Diagnostics),
        );
        assert_eq!(updated.right.active, Some(PanelId::Diagnostics));
        // The bottom zone (a different dock) is untouched.
        assert_eq!(updated.bottom.active, Some(PanelId::Controls));
    }

    #[test]
    fn activate_panel_is_a_no_op_for_a_panel_hosted_nowhere() {
        let layout = WorkspaceLayout {
            left: DockZone::default(),
            right: DockZone::hosting(vec![PanelId::Graph]),
            bottom: DockZone::default(),
        };
        // Diagnostics isn't hosted anywhere in this layout.
        let updated = reduce_workspace_intent(
            &layout,
            WorkspaceIntent::ActivatePanel(PanelId::Diagnostics),
        );
        assert_eq!(updated, layout);
    }

    #[test]
    fn toggle_collapsed_affects_only_the_named_dock() {
        let layout = WorkspaceLayout::default_for_machinewright();
        let updated =
            reduce_workspace_intent(&layout, WorkspaceIntent::ToggleCollapsed(Dock::Bottom));
        assert!(updated.bottom.collapsed);
        assert!(!updated.right.collapsed);
        assert!(!updated.left.collapsed);

        let restored =
            reduce_workspace_intent(&updated, WorkspaceIntent::ToggleCollapsed(Dock::Bottom));
        assert!(!restored.bottom.collapsed);
    }

    #[test]
    fn is_visible_true_only_for_the_active_uncollapsed_panel() {
        let layout = WorkspaceLayout::default_for_machinewright();
        assert!(layout.is_visible(PanelId::Controls));
        assert!(!layout.is_visible(PanelId::Sweep));

        let switched =
            reduce_workspace_intent(&layout, WorkspaceIntent::ActivatePanel(PanelId::Sweep));
        assert!(switched.is_visible(PanelId::Sweep));
        assert!(!switched.is_visible(PanelId::Controls));

        let collapsed =
            reduce_workspace_intent(&switched, WorkspaceIntent::ToggleCollapsed(Dock::Bottom));
        assert!(!collapsed.is_visible(PanelId::Sweep));
    }

    #[test]
    fn is_visible_false_for_a_panel_hosted_nowhere() {
        let layout = WorkspaceLayout {
            left: DockZone::default(),
            right: DockZone::hosting(vec![PanelId::Graph]),
            bottom: DockZone::default(),
        };
        assert!(!layout.is_visible(PanelId::Diagnostics));
    }
}
