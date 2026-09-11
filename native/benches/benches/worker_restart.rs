//! RFD-19's "worker restart" reference workload.
//!
//! This benches the real bounded-restart *policy* in `WorkerSupervisor` —
//! the decision logic that governs "Worker crash: retain the last valid
//! snapshot... offer or perform a bounded restart" — rather than actually
//! spawning and killing OS processes. Real process spawn/kill latency is
//! dominated by the OS and platform (this workspace's CI runs macOS,
//! Windows, and Linux, and nothing in the codebase exercises
//! `WorkerProcess::spawn` cross-platform today), so it would tell us more
//! about the runner than about Machinewright's own code. The pure policy
//! state machine is what Machinewright actually controls.

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use machinewright_evaluator::{ResourcePolicy, ResourceSample, SupervisorAction, WorkerSupervisor};
use std::time::Duration;

fn bench_bounded_restart_cycle(c: &mut Criterion) {
    let policy = ResourcePolicy::default();
    c.bench_function("worker_restart_bounded_cycle_to_exhaustion", |b| {
        b.iter_batched(
            || WorkerSupervisor::new(policy),
            |mut supervisor| {
                let mut now = Duration::ZERO;
                for _ in 0..policy.restart_limit {
                    now += Duration::from_millis(10);
                    let action = supervisor.record_exit(now);
                    debug_assert!(matches!(action, SupervisorAction::Terminate(_)));
                }
                now += Duration::from_millis(10);
                debug_assert_eq!(
                    supervisor.record_exit(now),
                    SupervisorAction::RecoveryRequired
                );
                supervisor.retry_explicitly();
            },
            BatchSize::SmallInput,
        );
    });
}

fn bench_resource_observation_tick(c: &mut Criterion) {
    let mut supervisor = WorkerSupervisor::new(ResourcePolicy::default());
    c.bench_function("worker_resource_observation_tick", |b| {
        b.iter(|| {
            supervisor.observe(ResourceSample {
                elapsed: Duration::from_millis(500),
                resident_bytes: 512 * 1024 * 1024,
                cpu_percent: 12.5,
            })
        });
    });
}

criterion_group!(
    benches,
    bench_bounded_restart_cycle,
    bench_resource_observation_tick
);
criterion_main!(benches);
