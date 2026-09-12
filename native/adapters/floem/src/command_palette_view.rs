//! Floem rendering for the floating command palette
//! (`machinewright_ui::command_palette`): a text input plus a filtered,
//! keyboard-navigable list, absolutely positioned over the whole window.
//! This module only renders and translates interaction into intents — the
//! actual filtering/selection logic is the pure `reduce_command_palette_intent`
//! in `machinewright-ui`, unit-tested there without Floem.
//!
//! The overlay pattern (`.absolute()` + `.z_index(...)` + `.apply_if(!open,
//! |s| s.hide())`, kept permanently mounted rather than conditionally built)
//! mirrors floem's own built-in context-menu implementation — the one
//! existing precedent for a floating layer in this dependency tree, since
//! nothing in this app's own code had used absolute positioning before.

use floem::{
    IntoView,
    event::{Event, EventListener, EventPropagation},
    keyboard::{Key, NamedKey},
    reactive::{RwSignal, SignalGet, SignalUpdate, SignalWith, create_effect},
    views::{Decorators, container, dyn_stack, label, scroll, text_input, v_stack},
};
use machinewright_ui::command_palette::{
    CommandPaletteIntent, CommandPaletteViewModel, PaletteCommand, PaletteCommandId,
    reduce_command_palette_intent,
};

use crate::theme;

fn dispatch(
    palette: RwSignal<CommandPaletteViewModel>,
    intent: CommandPaletteIntent,
) -> Option<PaletteCommandId> {
    let mut confirmed = None;
    palette.update(|model| {
        let (updated, id) = reduce_command_palette_intent(model, intent);
        *model = updated;
        confirmed = id;
    });
    confirmed
}

/// Opens the palette with a freshly-built registry. Called from the
/// `Cmd+P` handler in `main.rs`; also usable for a future "show all
/// commands" entry point without duplicating the `Open` plumbing.
pub fn open_palette(
    palette: RwSignal<CommandPaletteViewModel>,
    query_text: RwSignal<String>,
    commands: Vec<PaletteCommand>,
) {
    query_text.set(String::new());
    dispatch(palette, CommandPaletteIntent::Open(commands));
}

/// Confirms whichever row is at `position` within the current filtered
/// list: moves selection there, runs the reduce's `Confirm`, hands the
/// resulting id to the adapter, then closes. Shared by a row click and the
/// Enter key so both funnel through the same path. A free function (not a
/// closure) so it can be called from two different event handlers without
/// fighting move semantics.
fn confirm_selected_at(
    palette: RwSignal<CommandPaletteViewModel>,
    position: usize,
    on_confirm: &dyn Fn(PaletteCommandId),
) {
    dispatch(palette, CommandPaletteIntent::Hover(position));
    if let Some(id) = dispatch(palette, CommandPaletteIntent::Confirm) {
        on_confirm(id);
    }
    dispatch(palette, CommandPaletteIntent::Close);
}

/// Builds the always-mounted floating overlay. `on_confirm` receives the
/// selected command's id and is responsible for actually carrying it out
/// (open a file, spawn a new window, ...) — this module never interprets
/// a `PaletteCommandId` itself, matching the generic-registry design in
/// `machinewright_ui::command_palette`.
pub fn command_palette_overlay(
    palette: RwSignal<CommandPaletteViewModel>,
    query_text: RwSignal<String>,
    on_confirm: impl Fn(PaletteCommandId) + Clone + 'static,
) -> impl IntoView {
    // Bridges the plain `RwSignal<String>` `text_input` needs onto the
    // view model's own `query` field: every keystroke re-filters. `Open`
    // clears `query_text` itself (see `open_palette`), so this doesn't
    // fight that reset.
    create_effect(move |_| {
        let text = query_text.get();
        dispatch(palette, CommandPaletteIntent::QueryChanged(text));
    });

    let row_on_confirm = on_confirm.clone();
    let results = dyn_stack(
        move || palette.get().filtered.clone(),
        |index: &usize| *index,
        move |index| {
            let on_confirm = row_on_confirm.clone();
            let command = palette.with_untracked(|model| model.commands[index].clone());
            let row_label = match &command.subtitle {
                Some(subtitle) => format!("{}  ·  {subtitle}", command.title),
                None => command.title.clone(),
            };
            label(move || row_label.clone())
                .on_click_stop(move |_| {
                    let position = palette
                        .with_untracked(|model| model.filtered.iter().position(|&i| i == index));
                    if let Some(position) = position {
                        confirm_selected_at(palette, position, &on_confirm);
                    }
                })
                .style(move |style| {
                    let model = palette.get();
                    let is_selected = model.filtered.get(model.selected) == Some(&index);
                    let style = style
                        .width_full()
                        .padding_horiz(theme::space::SM)
                        .padding_vert(theme::space::XS)
                        .border_radius(theme::RADIUS_SM_PX);
                    if is_selected {
                        style.background(theme::accent_tint())
                    } else {
                        style
                    }
                })
        },
    )
    .style(|style| style.flex_col().width_full());

    let query_input = text_input(query_text).style(|style| {
        style
            .width_full()
            .padding(theme::space::SM)
            .border(theme::BORDER_WIDTH_PX)
            .border_color(theme::border())
            .border_radius(theme::RADIUS_SM_PX)
    });

    let panel = v_stack((
        query_input,
        scroll(results).style(|style| style.max_height(360.0).width_full()),
    ))
    .style(move |style| {
        style
            .width(560.0)
            .background(theme::surface_raised())
            .border(theme::BORDER_WIDTH_PX)
            .border_color(theme::border())
            .border_radius(theme::RADIUS_MD_PX)
            .padding(theme::space::SM)
            .gap(theme::space::SM)
            .box_shadow_blur(24.0)
            .box_shadow_color(theme::scrim(60))
    })
    // Stops a click that starts inside the panel (query input, a row, or
    // empty panel padding) from bubbling up to the scrim's close handler
    // below — only a click that never touches the panel should close it.
    .on_click_stop(|_| {});

    let key_on_confirm = on_confirm;
    container(panel)
        // Captures navigation keys before they can reach the root
        // `KeyDown` listener in `main.rs` (a child's own event handler
        // runs, and can stop propagation, before an ancestor's) — so
        // Enter/Escape don't also trigger Evaluate/cancel-measurement
        // while the palette is open. Any other key (character typing)
        // falls through as `Continue` so the `text_input` above still
        // receives it via its own handling.
        .on_event(EventListener::KeyDown, move |event| {
            if !palette.get_untracked().open {
                return EventPropagation::Continue;
            }
            let Event::KeyDown(key_event) = event else {
                return EventPropagation::Continue;
            };
            match &key_event.key.logical_key {
                Key::Named(NamedKey::Escape) => {
                    dispatch(palette, CommandPaletteIntent::Close);
                    EventPropagation::Stop
                }
                Key::Named(NamedKey::ArrowDown) => {
                    dispatch(palette, CommandPaletteIntent::MoveSelection(1));
                    EventPropagation::Stop
                }
                Key::Named(NamedKey::ArrowUp) => {
                    dispatch(palette, CommandPaletteIntent::MoveSelection(-1));
                    EventPropagation::Stop
                }
                Key::Named(NamedKey::Enter) => {
                    let selected = palette.get_untracked().selected;
                    confirm_selected_at(palette, selected, &key_on_confirm);
                    EventPropagation::Stop
                }
                _ => EventPropagation::Continue,
            }
        })
        // A click that reaches here never touched the panel (its own
        // `on_click_stop` above would have consumed it first), so it was
        // on the scrim — close.
        .on_click_stop(move |_| {
            dispatch(palette, CommandPaletteIntent::Close);
        })
        .style(move |style| {
            let open = palette.get().open;
            style
                .absolute()
                .inset(0.0)
                .width_full()
                .height_full()
                .items_center()
                .justify_center()
                .background(theme::scrim(90))
                .z_index(1000)
                .apply_if(!open, |s| s.hide())
        })
}
