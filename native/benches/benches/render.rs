//! RFD-19's "measure, rather than assume" reference workloads for the
//! viewport: a 100,000-triangle and a 1,000,000-triangle assembly, timing
//! both a full render and a pick against each. The renderer needs a real
//! GPU adapter; on a machine without one these benches skip with a clear
//! message rather than failing.

use std::time::Duration;

use criterion::{Criterion, criterion_group, criterion_main};
use machinewright_render::{Mesh, OffscreenRenderer, Scene, SceneMesh, ViewportState};

/// Encodes independent, non-shared triangles into the MWM1 mesh format
/// (mirroring `machinewright-render`'s own private test fixtures) so a
/// synthetic mesh of an arbitrary triangle count can be built without any
/// CAD backend.
fn encode_mwm1(vertices: &[[f64; 3]], triangles: &[[u32; 3]]) -> Vec<u8> {
    let mut bytes = b"MWM1".to_vec();
    bytes.extend_from_slice(&(vertices.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for vertex in vertices {
        for value in vertex {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    for triangle in triangles {
        for index in triangle {
            bytes.extend_from_slice(&index.to_le_bytes());
        }
    }
    bytes
}

fn synthetic_triangles(count: u32, origin: [f64; 3]) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let mut vertices = Vec::with_capacity(count as usize * 3);
    let mut triangles = Vec::with_capacity(count as usize);
    for index in 0..count {
        let offset = f64::from(index) * 0.02;
        let base = vertices.len() as u32;
        vertices.push([origin[0] + offset, origin[1], origin[2]]);
        vertices.push([origin[0] + offset + 0.01, origin[1], origin[2]]);
        vertices.push([origin[0] + offset, origin[1] + 0.01, origin[2]]);
        triangles.push([base, base + 1, base + 2]);
    }
    (vertices, triangles)
}

/// A synthetic "assembly": `part_count` components spread across a grid
/// (as separate meshes, like a real CAD assembly's distinct graph nodes),
/// each contributing `total_triangles / part_count` triangles.
fn synthetic_scene(total_triangles: u32, part_count: u32) -> Scene {
    let per_part = total_triangles / part_count;
    let meshes = (0..part_count)
        .map(|part| {
            let origin = [
                f64::from(part % 10) * 2.0,
                f64::from((part / 10) % 10) * 2.0,
                f64::from(part / 100) * 2.0,
            ];
            let (vertices, triangles) = synthetic_triangles(per_part, origin);
            let bytes = encode_mwm1(&vertices, &triangles);
            SceneMesh {
                graph_node_id: format!("part-{part}"),
                mesh: Mesh::decode(&bytes).expect("synthetic mesh decodes"),
            }
        })
        .collect();
    Scene { meshes }
}

fn bench_render(c: &mut Criterion) {
    let Ok(mut renderer) = pollster::block_on(OffscreenRenderer::new()) else {
        eprintln!("skipping render benches: no GPU adapter available in this environment");
        return;
    };
    let mut state = ViewportState::default();

    let mut group = c.benchmark_group("viewport_render_rgba");
    group.sample_size(10);
    group.measurement_time(Duration::from_secs(10));
    for (label, triangles, parts) in [
        ("100k_triangles", 100_000u32, 100u32),
        ("1m_triangles", 1_000_000u32, 500u32),
    ] {
        let scene = synthetic_scene(triangles, parts);
        scene.fit_camera(&mut state.camera);
        group.bench_function(label, |b| {
            b.iter(|| renderer.render_rgba(&scene, &state, 800, 600).unwrap());
        });
    }
    group.finish();
}

fn bench_pick(c: &mut Criterion) {
    let mut group = c.benchmark_group("viewport_pick");
    group.sample_size(20);
    for (label, triangles, parts) in [
        ("100k_triangles", 100_000u32, 100u32),
        ("1m_triangles", 1_000_000u32, 500u32),
    ] {
        let scene = synthetic_scene(triangles, parts);
        let mut state = ViewportState::default();
        scene.fit_camera(&mut state.camera);
        group.bench_function(label, |b| {
            b.iter(|| scene.pick(&state, 400.0, 300.0, 800.0, 600.0));
        });
    }
    group.finish();
}

criterion_group!(benches, bench_render, bench_pick);
criterion_main!(benches);
