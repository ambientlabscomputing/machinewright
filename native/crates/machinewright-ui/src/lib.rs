//! Framework-neutral view-model/intent layer for Machinewright's panels.
//!
//! The RFD's proposed Rust workspace names a `machinewright-ui` crate
//! ("application views and commands") separate from the native executable,
//! so that a future UI-framework change replaces only the adapter, not
//! application or domain logic. Until M3, no such crate existed — every
//! panel's view logic (what to display, what a click means) lived directly
//! in the Floem adapter (`native/adapters/floem/src/main.rs`) as ad hoc
//! closures over Floem signals. This crate is that missing layer, built out
//! only as far as M3 actually needs it.
//!
//! Convention: one `{Panel}ViewModel` struct plus one `{Panel}Intent` enum
//! per panel (deliberately lighter than a trait hierarchy — this codebase
//! favors concrete data and pure functions over polymorphism; see
//! `machinewright_app::runtime::EvaluationRuntime`, `SelectionState`). A
//! view model is derived from a `ProjectSnapshot`/`ProjectSession` and is
//! plain data; an intent captures what a user action means independent of
//! how it was rendered; a `reduce_*` function turns an intent into the
//! `AppCommand` that carries it out. Every module here has zero Floem
//! dependency and is unit-tested without launching the adapter.
//!
//! `graph` is the first panel retrofitted onto this convention (a small,
//! contained proof that it holds for an existing panel, not just new M3
//! ones). Diagnostics, worker-status, and editor-chrome panels are
//! deliberately left as adapter-local closures for now — retrofitting them
//! is not required for M3.

pub mod command_palette;
pub mod controls;
pub mod graph;
pub mod sweep;
pub mod theme;
pub mod workspace;
