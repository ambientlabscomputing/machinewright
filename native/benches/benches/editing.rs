//! RFD-19's "rapid source edits" reference workload: the per-keystroke
//! path (`Document::replace_selections`) that backs "typing-to-local-
//! syntax-highlight latency is visually immediate."

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use machinewright_workspace::{Cursor, Document};

fn bench_rapid_source_edits(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("source.py");
    std::fs::write(&file, "value = 1\n".repeat(200)).unwrap();
    let baseline = Document::open(&file).unwrap();

    c.bench_function("rapid_source_edits_single_keystroke", |b| {
        b.iter_batched(
            || {
                let mut document = baseline.clone();
                document.set_cursors(vec![Cursor::caret(0)]).unwrap();
                document
            },
            |mut document| document.replace_selections("x").unwrap(),
            BatchSize::SmallInput,
        );
    });
}

criterion_group!(benches, bench_rapid_source_edits);
criterion_main!(benches);
