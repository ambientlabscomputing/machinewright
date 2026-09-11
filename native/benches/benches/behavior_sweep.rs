//! RFD-19's "100-point behavior sweep" reference workload.
//!
//! This benches the Rust-side `ProjectSession` dispatch overhead — session
//! bookkeeping, snapshot install (including remapping selection onto the
//! new snapshot), and node selection — for 100 sequential evaluation
//! results. It does *not* measure real Python evaluation time: there is no
//! worker process behind these snapshots, only synthetic ones built
//! in-process. That's deliberate — the point is to isolate and measure the
//! overhead Machinewright's own code adds on top of whatever the worker
//! takes, per RFD-19's "Selection feedback does not wait for Python."

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use machinewright_app::{AppCommand, ProjectSession};
use machinewright_model::ProjectSnapshot;
use serde_json::json;
use std::path::{Path, PathBuf};

fn project_root() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("machinewright.toml"),
        "project_id='bench'\nenvironment_lock='uv.lock'\ninput_configurations=['inputs.json']\n[[templates]]\nid='bench.template'\nversion='1'\nentrypoint='design:build'\n",
    )
    .unwrap();
    std::fs::write(root.path().join("uv.lock"), "lock").unwrap();
    std::fs::write(root.path().join("inputs.json"), "{}").unwrap();
    let entry = root.path().join("main.py");
    std::fs::write(&entry, "value = 1\n").unwrap();
    (root, entry)
}

fn snapshot(root: &Path, generation: u64) -> ProjectSnapshot {
    let document = json!({
        "schema_version": "1.0",
        "generation": generation,
        "graph_digest": "sha256:graph",
        "artifact_manifest_digest": "sha256:manifest",
        "graph": {"nodes": [{
            "node_id": "root/part", "instance_key": "part", "kind": "component",
            "definition_id": "bench.part", "parameters": {}
        }], "containment": []},
        "source_mappings": [], "dependencies": [], "diagnostics": [],
        "meshes": [], "observables": [], "evidence_requirements": [],
        "control_configuration": {}, "provenance": {}
    });
    let path = root.join(format!("snapshot-{generation}.json"));
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    ProjectSnapshot::load(&path).unwrap()
}

fn bench_hundred_point_sweep(c: &mut Criterion) {
    let (root, entry) = project_root();
    let snapshots: Vec<ProjectSnapshot> = (1..=100)
        .map(|generation| snapshot(root.path(), generation))
        .collect();

    c.bench_function("hundred_point_behavior_sweep_session_overhead", |b| {
        b.iter_batched(
            || ProjectSession::open(&entry).unwrap(),
            |mut session| {
                for point in &snapshots {
                    session.begin_evaluation();
                    session
                        .dispatch(AppCommand::InstallSnapshot(point.clone()))
                        .unwrap();
                    session
                        .dispatch(AppCommand::SelectNode("root/part".into()))
                        .unwrap();
                }
            },
            BatchSize::SmallInput,
        );
    });
}

criterion_group!(benches, bench_hundred_point_sweep);
criterion_main!(benches);
