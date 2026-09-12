//! Framework-neutral view-model/intent pair for the graph view — the first
//! panel retrofitted onto the `machinewright-ui` convention (see the crate
//! doc comment). `GraphRow`/`graph_rows` were previously defined directly in
//! `native/adapters/floem/src/main.rs`; they had no Floem dependency even
//! there, so moving them here is a pure relocation. `GraphIntent`/
//! `reduce_graph_intent` are new: they give "a user clicked this row" a
//! framework-neutral meaning (an `AppCommand`) instead of the adapter
//! constructing `AppCommand::SelectNode` inline.
//!
//! What stays adapter-side: the cross-panel *consequences* of a selection
//! change (opening the mapped source document, moving the editor cursor,
//! refocusing the viewport, updating inspector text) are not graph-view
//! logic — they react to `ProjectSession.selection` regardless of whether
//! it changed via a graph click, a viewport pick, or something else. They
//! stay in the adapter, driven by the `SelectionState` an intent's
//! `AppCommand` produces once dispatched.

use std::collections::{BTreeSet, HashSet};

use machinewright_app::AppCommand;
use machinewright_model::{ProjectSnapshot, SelectionState};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GraphRow {
    pub node_id: String,
    pub label: String,
    pub depth: usize,
}

/// A depth-first listing of every node reachable from a root, followed by
/// any node no root reached (e.g. a cycle or an orphaned containment edge)
/// — every node in the graph appears exactly once.
pub fn graph_rows(snapshot: &ProjectSnapshot) -> Vec<GraphRow> {
    fn append(
        snapshot: &ProjectSnapshot,
        node_id: &str,
        depth: usize,
        rows: &mut Vec<GraphRow>,
        visited: &mut HashSet<String>,
    ) {
        if !visited.insert(node_id.to_owned()) {
            return;
        }
        let Some(node) = snapshot.graph().nodes.get(node_id) else {
            return;
        };
        rows.push(GraphRow {
            node_id: node_id.into(),
            label: format!("{} · {}", node.instance_key, node.kind),
            depth,
        });
        if let Some(children) = snapshot.graph().children.get(node_id) {
            for child in children {
                append(snapshot, child, depth + 1, rows, visited);
            }
        }
    }
    let mut rows = Vec::new();
    let mut visited = HashSet::new();
    for root in snapshot.graph().roots() {
        append(snapshot, &root.node_id, 0, &mut rows, &mut visited);
    }
    for node_id in snapshot.graph().nodes.keys() {
        append(snapshot, node_id, 0, &mut rows, &mut visited);
    }
    rows
}

/// The graph view's row list plus which rows are currently highlighted —
/// everything a renderer needs to draw the panel without touching
/// `ProjectSnapshot`/`SelectionState` directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphViewModel {
    pub rows: Vec<GraphRow>,
    pub highlighted: BTreeSet<String>,
}

impl GraphViewModel {
    pub fn derive(snapshot: &ProjectSnapshot, selection: &SelectionState) -> Self {
        Self {
            rows: graph_rows(snapshot),
            highlighted: selection.graph_node_ids.iter().cloned().collect(),
        }
    }
}

/// A user action against the graph view, independent of how it was
/// rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphIntent {
    NodeClicked { node_id: String },
}

/// Turns a graph-view intent into the session command that carries it out.
/// The adapter dispatches the resulting command and then reacts to the
/// resulting `SelectionState` (source navigation, viewport focus,
/// inspector text) — that reaction is cross-panel orchestration, not part
/// of this view-model.
pub fn reduce_graph_intent(intent: GraphIntent) -> AppCommand {
    match intent {
        GraphIntent::NodeClicked { node_id } => AppCommand::SelectNode(node_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot_with(document: serde_json::Value) -> ProjectSnapshot {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.json");
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        // Leak the tempdir so the file outlives this function; tests are
        // short-lived processes so this is an acceptable trade for not
        // threading a guard through every call site.
        Box::leak(Box::new(dir));
        ProjectSnapshot::load(&path).unwrap()
    }

    fn base_document() -> serde_json::Value {
        json!({
            "schema_version": "1.0",
            "generation": 1,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {
                "nodes": [
                    {"node_id": "a", "instance_key": "a", "kind": "assembly", "definition_id": "test.assembly", "parameters": {}},
                    {"node_id": "b", "instance_key": "b", "kind": "part", "definition_id": "test.part", "parameters": {}},
                ],
                "containment": [
                    {"edge_id": "e1", "parent_node_id": "a", "child_node_id": "b"},
                ],
            },
            "source_mappings": [], "dependencies": [], "diagnostics": [],
            "meshes": [], "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        })
    }

    #[test]
    fn graph_rows_lists_every_node_depth_first_from_its_root() {
        let snapshot = snapshot_with(base_document());
        let rows = graph_rows(&snapshot);
        assert_eq!(
            rows,
            vec![
                GraphRow {
                    node_id: "a".into(),
                    label: "a · assembly".into(),
                    depth: 0
                },
                GraphRow {
                    node_id: "b".into(),
                    label: "b · part".into(),
                    depth: 1
                },
            ]
        );
    }

    #[test]
    fn view_model_highlights_exactly_the_selected_node_ids() {
        let snapshot = snapshot_with(base_document());
        let selection = SelectionState {
            graph_node_ids: vec!["a".into(), "b".into()],
            ..SelectionState::default()
        };
        let view_model = GraphViewModel::derive(&snapshot, &selection);
        assert_eq!(view_model.rows.len(), 2);
        assert_eq!(
            view_model.highlighted,
            BTreeSet::from(["a".to_owned(), "b".to_owned()])
        );
    }

    #[test]
    fn node_clicked_reduces_to_select_node() {
        let command = reduce_graph_intent(GraphIntent::NodeClicked {
            node_id: "b".into(),
        });
        match command {
            AppCommand::SelectNode(node_id) => assert_eq!(node_id, "b"),
            other => panic!("expected SelectNode, got {other:?}"),
        }
    }
}
