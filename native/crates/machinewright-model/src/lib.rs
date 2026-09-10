use std::{collections::BTreeMap, fs, path::Path, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeshReference {
    #[serde(default = "default_mesh_encoding")]
    pub encoding: String,
    pub graph_node_id: String,
    pub digest: String,
    pub name: String,
    pub byte_size: u64,
    pub vertex_count: u32,
    pub triangle_count: u32,
    #[serde(default)]
    pub bounds: Option<[String; 6]>,
}

fn default_mesh_encoding() -> String {
    "mwm1".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub path: String,
    pub source_digest: String,
    pub start_byte: u64,
    pub end_byte: u64,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceMapping {
    pub source_id: String,
    pub node_ids: Vec<String>,
    pub span: SourceSpan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationSnapshot {
    pub schema_version: String,
    pub generation: u64,
    pub graph_digest: String,
    pub artifact_manifest_digest: String,
    pub graph: Value,
    #[serde(default)]
    pub source_mappings: Vec<SourceMapping>,
    #[serde(default)]
    pub dependencies: Vec<Value>,
    #[serde(default)]
    pub diagnostics: Vec<Value>,
    #[serde(default)]
    pub meshes: Vec<MeshReference>,
    #[serde(default)]
    pub observables: Vec<Value>,
    #[serde(default)]
    pub evidence_requirements: Vec<Value>,
    #[serde(default)]
    pub control_configuration: Value,
    pub provenance: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub node_id: String,
    pub instance_key: String,
    pub kind: String,
    pub definition_id: String,
    #[serde(default)]
    pub material_name: Option<String>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainmentEdge {
    pub edge_id: String,
    pub parent_node_id: String,
    pub child_node_id: String,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default)]
pub struct GraphIndex {
    pub nodes: BTreeMap<String, GraphNode>,
    pub children: BTreeMap<String, Vec<String>>,
    pub parent: BTreeMap<String, String>,
}

impl GraphIndex {
    fn from_value(graph: &Value) -> Result<Self, serde_json::Error> {
        let nodes = serde_json::from_value::<Vec<GraphNode>>(graph["nodes"].clone())?
            .into_iter()
            .map(|node| (node.node_id.clone(), node))
            .collect();
        let containment = serde_json::from_value::<Vec<ContainmentEdge>>(
            graph
                .get("containment")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        )?;
        let mut children = BTreeMap::<String, Vec<String>>::new();
        let mut parent = BTreeMap::new();
        for edge in containment {
            children
                .entry(edge.parent_node_id.clone())
                .or_default()
                .push(edge.child_node_id.clone());
            parent.insert(edge.child_node_id, edge.parent_node_id);
        }
        for values in children.values_mut() {
            values.sort();
        }
        Ok(Self {
            nodes,
            children,
            parent,
        })
    }

    pub fn roots(&self) -> impl Iterator<Item = &GraphNode> {
        self.nodes
            .values()
            .filter(|node| !self.parent.contains_key(&node.node_id))
    }

    pub fn descendants(&self, node_id: &str) -> Vec<&GraphNode> {
        let mut pending = self.children.get(node_id).cloned().unwrap_or_default();
        let mut result = Vec::new();
        while let Some(id) = pending.pop() {
            if let Some(node) = self.nodes.get(&id) {
                result.push(node);
            }
            if let Some(children) = self.children.get(&id) {
                pending.extend(children.iter().cloned());
            }
        }
        result
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectionState {
    pub generation: u64,
    /// Every component owned by the selected source mapping. The first entry is
    /// the primary component used for navigation and viewport focus.
    pub graph_node_ids: Vec<String>,
    pub graph_node_id: Option<String>,
    pub primitive: Option<u32>,
    pub source_span: Option<SourceSpan>,
    pub world_position: Option<[f64; 3]>,
    pub stale_source: bool,
}

#[derive(Debug, Clone)]
pub struct ProjectSnapshot {
    evaluation: Arc<EvaluationSnapshot>,
    graph: Arc<GraphIndex>,
}

impl ProjectSnapshot {
    pub fn load(path: &Path) -> Result<Self, SnapshotError> {
        let bytes = fs::read(path)?;
        let snapshot: EvaluationSnapshot = serde_json::from_slice(&bytes)?;
        let graph = GraphIndex::from_value(&snapshot.graph)?;
        Ok(Self {
            evaluation: Arc::new(snapshot),
            graph: Arc::new(graph),
        })
    }

    pub fn evaluation(&self) -> &EvaluationSnapshot {
        &self.evaluation
    }

    pub fn graph(&self) -> &GraphIndex {
        &self.graph
    }

    pub fn nodes_for_source(&self, source_id: &str) -> &[String] {
        self.evaluation
            .source_mappings
            .iter()
            .find(|mapping| mapping.source_id == source_id)
            .map_or(&[], |mapping| mapping.node_ids.as_slice())
    }

    pub fn source_for_node(&self, node_id: &str) -> Option<&SourceSpan> {
        self.evaluation
            .source_mappings
            .iter()
            .find(|mapping| {
                mapping
                    .node_ids
                    .iter()
                    .any(|candidate| candidate == node_id)
            })
            .map(|mapping| &mapping.span)
    }

    pub fn selection_for_node(&self, node_id: &str) -> SelectionState {
        let selected = self.graph.nodes.contains_key(node_id);
        SelectionState {
            generation: self.evaluation.generation,
            graph_node_ids: selected.then(|| node_id.to_owned()).into_iter().collect(),
            graph_node_id: selected.then(|| node_id.to_owned()),
            source_span: self.source_for_node(node_id).cloned(),
            ..SelectionState::default()
        }
    }

    pub fn selection_for_source(&self, path: &str, byte: u64) -> SelectionState {
        let mapping = self
            .evaluation
            .source_mappings
            .iter()
            .filter(|mapping| {
                mapping.span.path == path
                    && mapping.span.start_byte <= byte
                    && byte <= mapping.span.end_byte
            })
            .min_by_key(|mapping| mapping.span.end_byte - mapping.span.start_byte);
        mapping.map_or_else(
            || SelectionState {
                generation: self.evaluation.generation,
                ..SelectionState::default()
            },
            |mapping| SelectionState {
                generation: self.evaluation.generation,
                graph_node_ids: mapping.node_ids.clone(),
                graph_node_id: mapping.node_ids.first().cloned(),
                source_span: Some(mapping.span.clone()),
                ..SelectionState::default()
            },
        )
    }
}

#[derive(Debug, Error)]
pub enum SnapshotError {
    #[error("snapshot I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("snapshot JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}
