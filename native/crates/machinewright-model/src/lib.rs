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

/// A part instance's placement within its assembly: an off-the-shelf part
/// (e.g. a dowel pin used twice) tessellates identically in its own local
/// frame regardless of where it sits in the assembly — that's what lets
/// identical instances content-address to the same cached mesh bytes — so
/// this instance-level placement is carried separately, in the graph node's
/// `transform` extension, rather than baked into the mesh.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NodeTransform {
    pub translation_mm: [f64; 3],
    pub rotation_degrees_xyz: [f64; 3],
}

impl Default for NodeTransform {
    fn default() -> Self {
        Self {
            translation_mm: [0.0; 3],
            rotation_degrees_xyz: [0.0; 3],
        }
    }
}

impl GraphNode {
    /// Reads this node's placement from its `transform` extension, falling
    /// back to the identity transform if the extension is absent or
    /// malformed. Component values are ordinarily encoded as decimal
    /// strings (matching every other physical quantity in the graph JSON,
    /// e.g. `envelope_mm`/`center_mm`), but a plain JSON number is accepted
    /// too.
    pub fn transform(&self) -> NodeTransform {
        fn triplet(value: &Value, key: &str) -> Option<[f64; 3]> {
            let array = value.get(key)?.as_array()?;
            let mut out = [0.0; 3];
            for (slot, entry) in out.iter_mut().zip(array) {
                *slot = entry
                    .as_str()
                    .and_then(|text| text.parse().ok())
                    .or_else(|| entry.as_f64())?;
            }
            Some(out)
        }
        let Some(transform) = self.extensions.get("transform") else {
            return NodeTransform::default();
        };
        NodeTransform {
            translation_mm: triplet(transform, "translation_mm").unwrap_or_default(),
            rotation_degrees_xyz: triplet(transform, "rotation_degrees_xyz").unwrap_or_default(),
        }
    }
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

    /// The mapping is deterministically the narrowest one covering
    /// `node_id`: a node-level mapping has exactly one node id, a
    /// definition-level mapping has however many instances share that
    /// definition, and the whole-template mapping has every node in the
    /// graph — so the smallest `node_ids` set is always the most specific,
    /// regardless of emission order.
    pub fn source_mapping_for_node(&self, node_id: &str) -> Option<&SourceMapping> {
        self.evaluation
            .source_mappings
            .iter()
            .filter(|mapping| {
                mapping
                    .node_ids
                    .iter()
                    .any(|candidate| candidate == node_id)
            })
            .min_by_key(|mapping| mapping.node_ids.len())
    }

    pub fn source_for_node(&self, node_id: &str) -> Option<&SourceSpan> {
        self.source_mapping_for_node(node_id).map(|mapping| &mapping.span)
    }

    /// Selecting one node highlights every graph node owned by the same
    /// source mapping (e.g. two instances created by the same call site),
    /// not just the node that was clicked — `graph_node_id` stays the
    /// clicked node so navigation/labeling still target it specifically.
    pub fn selection_for_node(&self, node_id: &str) -> SelectionState {
        if !self.graph.nodes.contains_key(node_id) {
            return SelectionState {
                generation: self.evaluation.generation,
                ..SelectionState::default()
            };
        }
        let mapping = self.source_mapping_for_node(node_id);
        let mut graph_node_ids: Vec<String> = mapping.map_or_else(Vec::new, |mapping| {
            mapping
                .node_ids
                .iter()
                .filter(|candidate| self.graph.nodes.contains_key(candidate.as_str()))
                .cloned()
                .collect()
        });
        if graph_node_ids.is_empty() {
            graph_node_ids.push(node_id.to_owned());
        }
        SelectionState {
            generation: self.evaluation.generation,
            graph_node_ids,
            graph_node_id: Some(node_id.to_owned()),
            source_span: mapping.map(|mapping| mapping.span.clone()),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn node(extensions: BTreeMap<String, Value>) -> GraphNode {
        GraphNode {
            node_id: "n".into(),
            instance_key: "n".into(),
            kind: "part".into(),
            definition_id: "test.part".into(),
            material_name: None,
            parameters: Value::Null,
            extensions,
        }
    }

    #[test]
    fn source_for_node_prefers_the_narrowest_overlapping_mapping() {
        // A whole-template mapping covers every node; a node-level mapping
        // covers exactly one. The node-level mapping must win regardless of
        // which order they appear in `source_mappings`.
        let document = serde_json::json!({
            "schema_version": "1.0",
            "generation": 1,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {
                "nodes": [
                    {
                        "node_id": "a", "instance_key": "a", "kind": "component",
                        "definition_id": "test.part", "parameters": {}
                    },
                    {
                        "node_id": "b", "instance_key": "b", "kind": "component",
                        "definition_id": "test.part", "parameters": {}
                    },
                ],
                "containment": [],
            },
            "source_mappings": [
                {
                    "source_id": "template:test@1.0.0",
                    "node_ids": ["a", "b"],
                    "span": {
                        "path": "template.py", "source_digest": "sha256:template",
                        "start_byte": 0, "end_byte": 100, "start_line": 1, "end_line": 10,
                    },
                },
                {
                    "source_id": "node:a",
                    "node_ids": ["a"],
                    "span": {
                        "path": "node.py", "source_digest": "sha256:node",
                        "start_byte": 5, "end_byte": 10, "start_line": 2, "end_line": 2,
                    },
                },
            ],
            "dependencies": [], "diagnostics": [],
            "meshes": [], "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        });
        let path = std::env::temp_dir().join(format!(
            "machinewright-model-test-{}-{:?}.json",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let snapshot = ProjectSnapshot::load(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let span = snapshot.source_for_node("a").expect("mapping exists");
        assert_eq!(span.path, "node.py");
    }

    #[test]
    fn transform_defaults_to_identity_when_absent() {
        let node = node(BTreeMap::new());
        assert_eq!(node.transform(), NodeTransform::default());
    }

    #[test]
    fn transform_parses_decimal_string_components() {
        let node = node(BTreeMap::from([(
            "transform".into(),
            serde_json::json!({
                "translation_mm": ["1.5", "0", "-20"],
                "rotation_degrees_xyz": ["0", "90", "0"],
            }),
        )]));
        assert_eq!(
            node.transform(),
            NodeTransform {
                translation_mm: [1.5, 0.0, -20.0],
                rotation_degrees_xyz: [0.0, 90.0, 0.0],
            }
        );
    }

    #[test]
    fn transform_accepts_plain_json_numbers_too() {
        let node = node(BTreeMap::from([(
            "transform".into(),
            serde_json::json!({
                "translation_mm": [1.5, 0, -20],
                "rotation_degrees_xyz": [0, 90, 0],
            }),
        )]));
        assert_eq!(
            node.transform(),
            NodeTransform {
                translation_mm: [1.5, 0.0, -20.0],
                rotation_degrees_xyz: [0.0, 90.0, 0.0],
            }
        );
    }

    #[test]
    fn transform_falls_back_to_identity_on_malformed_data() {
        let node = node(BTreeMap::from([(
            "transform".into(),
            serde_json::json!({"translation_mm": "not an array"}),
        )]));
        assert_eq!(node.transform(), NodeTransform::default());
    }
}
