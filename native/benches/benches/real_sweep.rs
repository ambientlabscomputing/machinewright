//! RFD-19 M3's "100-point behavior sweep" reference workload, measured
//! against a *real* worker process evaluating the real reference project —
//! unlike `behavior_sweep.rs`, which the M2 implementation review
//! explicitly flagged as measuring only synthetic in-process
//! `ProjectSession` bookkeeping with "no worker process behind these
//! snapshots." Both benches are useful and neither substitutes for the
//! other: this one measures what a sweep actually costs end to end
//! (worker round trips included); `behavior_sweep.rs` isolates the
//! Rust-side overhead on top of that.
//!
//! Requires the repository's own Python environment to be set up (`uv
//! sync` at the repository root) — it spawns the real
//! `.venv/bin/machinewright-worker` against this repository's own
//! `machinewright.toml` project (the same one `examples/reference_project.py`
//! and `tests/test_rfd19_evaluation.py` use), evaluating real per-point
//! inputs through `machinewright_analysis::Sweep::from_axis` exactly as the
//! native app's sweep runner does.
//!
//! **This is genuinely slow** — confirmed by an actual run: each point
//! evaluation costs a few real seconds (Python import/CAD export, not
//! network or protocol overhead), so criterion's minimum 10 samples of a
//! 21-point sweep take on the order of tens of minutes, not seconds. That
//! is real signal for RFD-19's "measure, rather than assume" workloads, not
//! a bug to fix here — this bench is meant to be run deliberately (e.g.
//! before recording an M3 acceptance measurement), not as part of a fast
//! `cargo bench --workspace` loop.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use criterion::{Criterion, criterion_group, criterion_main};
use machinewright_analysis::Sweep;
use machinewright_app::{EvaluationPort, EvaluationRequest};
use machinewright_evaluator::WorkerProcess;
use machinewright_workspace::EnvironmentSpec;
use serde_json::json;

/// The Machinewright repository's own root — two levels up from this
/// bench crate (`native/benches` -> `native` -> the repository root),
/// which is itself a valid Machinewright project (see the top-level
/// `machinewright.toml`).
fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root exists")
}

fn axis_values(start: f64, stop: f64, points: usize) -> Vec<f64> {
    (0..points)
        .map(|index| start + (stop - start) * index as f64 / (points - 1) as f64)
        .collect()
}

fn bench_real_worker_sweep(c: &mut Criterion) {
    let root = project_root();
    let environment = match EnvironmentSpec::resolve(&root) {
        Ok(environment) => environment,
        Err(error) => {
            eprintln!(
                "skipping real_sweep bench: environment not resolvable ({error}) — run `uv sync` \
                 at the repository root first"
            );
            return;
        }
    };
    let mut worker = match WorkerProcess::spawn(&environment.worker_executable, std::iter::empty::<&str>())
    {
        Ok(worker) => worker,
        Err(error) => {
            eprintln!("skipping real_sweep bench: worker spawn failed ({error})");
            return;
        }
    };
    if let Err(error) = worker.negotiate(vec!["evaluation.v1".into()]) {
        eprintln!("skipping real_sweep bench: worker negotiation failed ({error})");
        return;
    }

    let base_inputs = json!({"requirements": {"payload_kg": 10.0}});
    // Stays within ReferenceInputs.payload_kg's `gt=0, le=100` bounds.
    let values = axis_values(3.0, 63.0, 21);
    let sweep = Sweep::from_axis(&base_inputs, "requirements.payload_kg", values)
        .expect("requirements.payload_kg is a valid object path");

    let output_root = tempfile::tempdir().expect("temp dir");
    let session_id = "bench-real-sweep".to_string();
    // A generation/directory counter shared across every criterion
    // iteration (not reset per sweep) so repeated bench iterations never
    // reuse a prior iteration's (session_id, generation) pair or output
    // directory — each point evaluation is genuinely fresh work for the
    // worker, not something it could recognize as already done.
    let next_generation = AtomicU64::new(1);

    c.bench_function("real_sweep_21_points_against_reference_project", |b| {
        b.iter(|| {
            let mut sweep = sweep.clone();
            while let Some(point) = sweep.next_pending() {
                let generation = next_generation.fetch_add(1, Ordering::SeqCst);
                let request = EvaluationRequest {
                    session_id: session_id.clone(),
                    generation,
                    project_root: root.clone(),
                    template_id: "machinewright.reference.simple".into(),
                    template_version: "1.0.0".into(),
                    inputs_json: serde_json::to_vec(&point.inputs).unwrap(),
                    output_directory: output_root
                        .path()
                        .join(format!("point-{generation:06}")),
                    overlays: Vec::new(),
                    environment_digest: environment.lock_digest.clone(),
                };
                worker
                    .evaluate(&request)
                    .expect("reference project evaluates successfully");
            }
        });
    });
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(10);
    targets = bench_real_worker_sweep
}
criterion_main!(benches);
