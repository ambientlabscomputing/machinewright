//! Framework-neutral view-model/intent pair for a floating command palette
//! (VS Code-style `Cmd+P`/`Cmd+K`-family UI): a searchable, keyboard-
//! navigable list of commands. This module owns *which command is
//! selected*, not what running it does — selecting a command yields an
//! opaque [`PaletteCommandId`] that the adapter maps to real work (open a
//! file, spawn a new window, run a sweep, ...). That split is what keeps
//! this reusable: adding a new command later is adapter-side registry data,
//! never a change here.
//!
//! Convention: same ViewModel/Intent/reduce shape as `workspace`, `graph`,
//! `controls`, `sweep` — pure, zero-Floem, unit-tested in this file.

/// Identifies a command a user can select. A plain string (not an enum of
/// app-specific variants) so the registry stays fully data-driven — e.g. a
/// per-file "open" command carries its path as `"open-file:<relative
/// path>"`, parsed back out adapter-side.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PaletteCommandId(pub String);

/// One entry in the palette's registry.
#[derive(Debug, Clone, PartialEq)]
pub struct PaletteCommand {
    pub id: PaletteCommandId,
    pub title: String,
    pub subtitle: Option<String>,
}

impl PaletteCommand {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: PaletteCommandId(id.into()),
            title: title.into(),
            subtitle: None,
        }
    }

    pub fn with_subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CommandPaletteViewModel {
    pub open: bool,
    pub query: String,
    /// The full, unfiltered registry as of the last `Open` — supplied fresh
    /// by the adapter each time (not cached across opens), so e.g. "open
    /// file" always reflects the current project tree.
    pub commands: Vec<PaletteCommand>,
    /// Indices into `commands`, ranked best-match-first.
    pub filtered: Vec<usize>,
    /// Index into `filtered` (not `commands`).
    pub selected: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandPaletteIntent {
    Open(Vec<PaletteCommand>),
    Close,
    QueryChanged(String),
    /// Moves the selection by this many rows (negative = up), wrapping.
    MoveSelection(i32),
    /// Selects a specific row within `filtered` directly (e.g. a mouse
    /// click), without confirming it.
    Hover(usize),
    /// Runs the currently selected command, if any.
    Confirm,
}

/// Applies one intent, returning the updated view model plus `Some(id)` iff
/// this intent was `Confirm` and a command was selected. Pure: never reads
/// or mutates anything outside `model`/`intent`.
pub fn reduce_command_palette_intent(
    model: &CommandPaletteViewModel,
    intent: CommandPaletteIntent,
) -> (CommandPaletteViewModel, Option<PaletteCommandId>) {
    let mut model = model.clone();
    match intent {
        CommandPaletteIntent::Open(commands) => {
            model.open = true;
            model.query.clear();
            model.commands = commands;
            model.filtered = rerank(&model.commands, "");
            model.selected = 0;
        }
        CommandPaletteIntent::Close => {
            model.open = false;
            model.query.clear();
            model.commands.clear();
            model.filtered.clear();
            model.selected = 0;
        }
        CommandPaletteIntent::QueryChanged(query) => {
            model.filtered = rerank(&model.commands, &query);
            model.query = query;
            if model.selected >= model.filtered.len() {
                model.selected = model.filtered.len().saturating_sub(1);
            }
        }
        CommandPaletteIntent::MoveSelection(delta) => {
            let len = model.filtered.len();
            if len > 0 {
                let current = model.selected as i32;
                let next = (current + delta).rem_euclid(len as i32);
                model.selected = next as usize;
            }
        }
        CommandPaletteIntent::Hover(index) => {
            if index < model.filtered.len() {
                model.selected = index;
            }
        }
        CommandPaletteIntent::Confirm => {
            let id = model
                .filtered
                .get(model.selected)
                .map(|&index| model.commands[index].id.clone());
            return (model, id);
        }
    }
    (model, None)
}

/// Re-filters and ranks `commands` against `query`. Empty query keeps
/// registry order (every command matches, all scoring equal).
fn rerank(commands: &[PaletteCommand], query: &str) -> Vec<usize> {
    if query.is_empty() {
        return (0..commands.len()).collect();
    }
    let mut scored: Vec<(usize, i32)> = commands
        .iter()
        .enumerate()
        .filter_map(|(index, command)| {
            let title_score = fuzzy_score(query, &command.title);
            let subtitle_score = command
                .subtitle
                .as_deref()
                .and_then(|subtitle| fuzzy_score(query, subtitle))
                .map(|score| score - 1000); // subtitle matches rank below title matches
            match (title_score, subtitle_score) {
                (Some(a), Some(b)) => Some((index, a.max(b))),
                (Some(a), None) => Some((index, a)),
                (None, Some(b)) => Some((index, b)),
                (None, None) => None,
            }
        })
        .collect();
    // Stable sort descending by score keeps equal-score entries in
    // registry order.
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored.into_iter().map(|(index, _)| index).collect()
}

/// A small, dependency-free fuzzy subsequence scorer: every character of
/// `query` (case-insensitive) must appear in `text` in order, not
/// necessarily contiguously. Higher score = better match; rewards
/// contiguous runs and matches starting at a word boundary (after `/`,
/// `_`, `-`, ' ', or a lowercase-to-uppercase transition) — the same
/// heuristic VS Code's Quick Open and Sublime's fuzzy matcher use. Returns
/// `None` if `query`'s characters aren't a subsequence of `text` at all.
fn fuzzy_score(query: &str, text: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let text_chars: Vec<char> = text.chars().collect();
    let query_chars: Vec<char> = query.chars().collect();

    let mut score = 0i32;
    let mut text_index = 0usize;
    let mut previous_matched_index: Option<usize> = None;

    for &query_char in &query_chars {
        let query_lower = query_char.to_ascii_lowercase();
        let found = (text_index..text_chars.len())
            .find(|&index| text_chars[index].to_ascii_lowercase() == query_lower)?;

        let is_boundary = found == 0
            || matches!(text_chars[found - 1], '/' | '_' | '-' | ' ' | '.')
            || (text_chars[found - 1].is_lowercase() && text_chars[found].is_uppercase());
        let is_contiguous = previous_matched_index == Some(found.wrapping_sub(1));

        score += 1;
        if is_boundary {
            score += 5;
        }
        if is_contiguous {
            // Weighted above the boundary bonus so a real contiguous
            // substring ("pin" inside "dowel_pin.py") outranks a match
            // scattered across several word starts ("dpn" also matches,
            // one boundary hit per letter, but isn't the substring a user
            // actually meant).
            score += 10;
        }

        previous_matched_index = Some(found);
        text_index = found + 1;
    }

    // Shorter overall text is a slightly better match, all else equal
    // (favors "main.py" over "main_test_helpers.py" for query "main").
    score -= (text_chars.len() as i32) / 32;
    Some(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands(titles: &[&str]) -> Vec<PaletteCommand> {
        titles
            .iter()
            .enumerate()
            .map(|(index, title)| PaletteCommand::new(format!("cmd-{index}"), *title))
            .collect()
    }

    #[test]
    fn fuzzy_score_matches_a_subsequence_and_rejects_a_non_subsequence() {
        assert!(fuzzy_score("dwl", "dowel_pin.py").is_some());
        assert!(fuzzy_score("xyz", "dowel_pin.py").is_none());
    }

    #[test]
    fn fuzzy_score_ranks_a_prefix_match_above_a_scattered_match() {
        let prefix = fuzzy_score("dow", "dowel_pin.py").unwrap();
        let scattered = fuzzy_score("dwl", "dowel_pin.py").unwrap();
        assert!(prefix > scattered, "prefix={prefix} scattered={scattered}");
    }

    #[test]
    fn fuzzy_score_ranks_a_contiguous_substring_above_a_non_contiguous_one() {
        let contiguous = fuzzy_score("pin", "dowel_pin.py").unwrap();
        let non_contiguous = fuzzy_score("dpn", "dowel_pin.py").unwrap();
        assert!(contiguous > non_contiguous);
    }

    #[test]
    fn open_populates_filtered_with_all_commands_in_registry_order_when_query_is_empty() {
        let model = CommandPaletteViewModel::default();
        let (updated, ran) = reduce_command_palette_intent(
            &model,
            CommandPaletteIntent::Open(commands(&["a", "b", "c"])),
        );
        assert!(updated.open);
        assert_eq!(updated.filtered, vec![0, 1, 2]);
        assert_eq!(updated.selected, 0);
        assert_eq!(ran, None);
    }

    #[test]
    fn query_changed_refilters_and_clamps_selection() {
        let (opened, _) = reduce_command_palette_intent(
            &CommandPaletteViewModel::default(),
            CommandPaletteIntent::Open(commands(&["dowel_pin.py", "box.py", "shoulder_bolt.py"])),
        );
        let (moved, _) =
            reduce_command_palette_intent(&opened, CommandPaletteIntent::MoveSelection(2));
        assert_eq!(moved.selected, 2);

        let (filtered, _) = reduce_command_palette_intent(
            &moved,
            CommandPaletteIntent::QueryChanged("dowel".to_string()),
        );
        assert_eq!(filtered.filtered, vec![0]);
        assert_eq!(
            filtered.selected, 0,
            "selection clamps into the shrunk filtered set"
        );
    }

    #[test]
    fn move_selection_wraps_at_both_ends_and_is_a_no_op_on_empty() {
        let (opened, _) = reduce_command_palette_intent(
            &CommandPaletteViewModel::default(),
            CommandPaletteIntent::Open(commands(&["a", "b", "c"])),
        );
        let (up, _) =
            reduce_command_palette_intent(&opened, CommandPaletteIntent::MoveSelection(-1));
        assert_eq!(up.selected, 2, "moving up from 0 wraps to the last row");

        let (down, _) = reduce_command_palette_intent(&up, CommandPaletteIntent::MoveSelection(1));
        assert_eq!(down.selected, 0);

        let empty = CommandPaletteViewModel::default();
        let (still_empty, _) =
            reduce_command_palette_intent(&empty, CommandPaletteIntent::MoveSelection(1));
        assert_eq!(still_empty.selected, 0);
    }

    #[test]
    fn confirm_returns_the_selected_command_or_none_when_filtered_is_empty() {
        let (opened, _) = reduce_command_palette_intent(
            &CommandPaletteViewModel::default(),
            CommandPaletteIntent::Open(commands(&["a", "b"])),
        );
        let (moved, _) =
            reduce_command_palette_intent(&opened, CommandPaletteIntent::MoveSelection(1));
        let (_, confirmed) = reduce_command_palette_intent(&moved, CommandPaletteIntent::Confirm);
        assert_eq!(confirmed, Some(PaletteCommandId("cmd-1".to_string())));

        let (filtered_to_nothing, _) = reduce_command_palette_intent(
            &opened,
            CommandPaletteIntent::QueryChanged("zzz".to_string()),
        );
        let (_, confirmed_none) =
            reduce_command_palette_intent(&filtered_to_nothing, CommandPaletteIntent::Confirm);
        assert_eq!(confirmed_none, None);
    }

    #[test]
    fn close_resets_transient_state() {
        let (opened, _) = reduce_command_palette_intent(
            &CommandPaletteViewModel::default(),
            CommandPaletteIntent::Open(commands(&["a", "b"])),
        );
        let (closed, _) = reduce_command_palette_intent(&opened, CommandPaletteIntent::Close);
        assert!(!closed.open);
        assert!(closed.query.is_empty());
        assert!(closed.commands.is_empty());
        assert!(closed.filtered.is_empty());
    }

    #[test]
    fn hover_selects_a_specific_row_without_confirming() {
        let (opened, _) = reduce_command_palette_intent(
            &CommandPaletteViewModel::default(),
            CommandPaletteIntent::Open(commands(&["a", "b", "c"])),
        );
        let (hovered, ran) = reduce_command_palette_intent(&opened, CommandPaletteIntent::Hover(2));
        assert_eq!(hovered.selected, 2);
        assert_eq!(ran, None);

        let (unchanged, _) =
            reduce_command_palette_intent(&hovered, CommandPaletteIntent::Hover(50));
        assert_eq!(unchanged.selected, 2, "an out-of-range hover is a no-op");
    }
}
