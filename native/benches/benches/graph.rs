//! RFD-19's "large graph" reference workload: the dependency-graph
//! traversal and per-click selection lookup that every graph-panel render
//! and viewport pick exercises, run against a synthetic 20,000-node tree.

use criterion::{Criterion, criterion_group, criterion_main};
use machinewright_model::ProjectSnapshot;
use serde_json::json;

fn synthetic_snapshot(node_count: u32, branching: u32) -> ProjectSnapshot {
    let mut nodes = Vec::with_capacity(node_count as usize);
    let mut containment = Vec::new();
    for id in 0..node_count {
        nodes.push(json!({
            "node_id": format!("node-{id}"),
            "instance_key": format!("node-{id}"),
            "kind": "component",
            "definition_id": "bench.part",
            "parameters": {}
        }));
        if id > 0 {
            let parent = (id - 1) / branching;
            containment.push(json!({
                "edge_id": format!("edge-{id}"),
                "parent_node_id": format!("node-{parent}"),
                "child_node_id": format!("node-{id}")
            }));
        }
    }
    let document = json!({
        "schema_version": "1.0",
        "generation": 1,
        "graph_digest": "sha256:graph",
        "artifact_manifest_digest": "sha256:manifest",
        "graph": {"nodes": nodes, "containment": containment},
        "source_mappings": [], "dependencies": [], "diagnostics": [],
        "meshes": [], "observables": [], "evidence_requirements": [],
        "control_configuration": {}, "provenance": {}
    });
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("snapshot.json");
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    ProjectSnapshot::load(&path).unwrap()
}

fn bench_large_graph(c: &mut Criterion) {
    const NODE_COUNT: u32 = 20_000;
    let snapshot = synthetic_snapshot(NODE_COUNT, 4);

    let mut group = c.benchmark_group("large_graph_20k_nodes");
    group.bench_function("descendants_of_root", |b| {
        b.iter(|| snapshot.graph().descendants("node-0"));
    });
    group.bench_function("selection_for_leaf_node", |b| {
        b.iter(|| snapshot.selection_for_node(&format!("node-{}", NODE_COUNT - 1)));
    });
    group.finish();
}

criterion_group!(benches, bench_large_graph);
criterion_main!(benches);
