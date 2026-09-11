use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::Path,
    sync::Arc,
};

use glam::{DMat4, DVec3, DVec4};
use machinewright_model::ProjectSnapshot;
use thiserror::Error;
use wgpu::util::DeviceExt;

const VIEWPORT_SHADER: &str = r#"
struct DrawUniform {
    transform: mat4x4<f32>,
    color: vec4<f32>,
    section_plane: vec4<f32>,
    has_section: vec4<f32>,
};

@group(0) @binding(0) var<uniform> draw: DrawUniform;

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) section_distance: f32,
};

@vertex
fn vertex_main(@location(0) position: vec4<f32>) -> VertexOut {
    var out: VertexOut;
    out.position = draw.transform * position;
    out.color = draw.color;
    let plane_distance = dot(draw.section_plane.xyz, position.xyz) + draw.section_plane.w;
    out.section_distance = select(1.0, plane_distance, draw.has_section.x > 0.5);
    return out;
}

@fragment
fn fragment_main(in: VertexOut) -> @location(0) vec4<f32> {
    if in.section_distance < 0.0 { discard; }
    return in.color;
}
"#;

/// A mesh's raw geometry, uploaded once and reused across frames. Position
/// only — per-draw state (camera transform, selection color, section plane)
/// lives in `DrawUniform` instead, so retaining this buffer across frames
/// doesn't require the mesh to be unselected, unsectioned, or viewed from a
/// fixed camera.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuVertex {
    position: [f32; 4],
}

/// Per-draw-call state: the camera transform and this specific mesh's
/// current color/section-plane visibility. Written fresh every frame into a
/// dynamic-offset uniform buffer — cheap, since it's a handful of floats per
/// visible mesh rather than the mesh's full vertex data.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct DrawUniform {
    transform: [[f32; 4]; 4],
    color: [f32; 4],
    section_plane: [f32; 4],
    has_section: [f32; 4],
}

struct CachedMesh {
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    index_count: u32,
    last_frame_used: u64,
}

/// Upper bound on distinct mesh geometries retained across frames. Each new
/// evaluation's meshes hash to new cache keys, so without a bound a long
/// editing session would grow this unboundedly; least-recently-drawn entries
/// are evicted once the bound is exceeded.
const MAX_CACHED_MESHES: usize = 256;

/// Framework-neutral offscreen renderer. UI adapters submit scene updates from a
/// background thread and display only the newest completed RGBA frame.
pub struct OffscreenRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_alignment: u64,
    targets: Vec<(wgpu::Texture, [u32; 2])>,
    next_target: usize,
    mesh_cache: HashMap<String, CachedMesh>,
    frame_counter: u64,
}

impl OffscreenRenderer {
    pub async fn new() -> Result<Self, MeshError> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or(MeshError::NoGpuAdapter)?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("machinewright-viewport"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults(),
                    memory_hints: wgpu::MemoryHints::MemoryUsage,
                },
                None,
            )
            .await
            .map_err(|error| MeshError::Gpu(error.to_string()))?;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("machinewright-viewport-shader"),
            source: wgpu::ShaderSource::Wgsl(VIEWPORT_SHADER.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("machinewright-viewport-draw-layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(
                        std::mem::size_of::<DrawUniform>() as u64
                    ),
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("machinewright-viewport-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let attributes = wgpu::vertex_attr_array![0 => Float32x4];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("machinewright-viewport-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vertex_main",
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<GpuVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &attributes,
                }],
            },
            primitive: wgpu::PrimitiveState {
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fragment_main",
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview: None,
            cache: None,
        });
        let uniform_alignment = u64::from(device.limits().min_uniform_buffer_offset_alignment);
        Ok(Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            uniform_alignment,
            targets: Vec::new(),
            next_target: 0,
            mesh_cache: HashMap::new(),
            frame_counter: 0,
        })
    }

    /// Uploads `mesh`'s geometry if it isn't already cached under `key`, and
    /// marks it used this frame either way so `evict_stale_meshes` retains it.
    fn ensure_cached_mesh(&mut self, key: &str, mesh: &Mesh) {
        if let Some(cached) = self.mesh_cache.get_mut(key) {
            cached.last_frame_used = self.frame_counter;
            return;
        }
        let vertices: Vec<GpuVertex> = mesh
            .vertices
            .iter()
            .map(|position| GpuVertex {
                position: [
                    position[0] as f32,
                    position[1] as f32,
                    position[2] as f32,
                    1.0,
                ],
            })
            .collect();
        let indices: Vec<u32> = mesh
            .triangles
            .iter()
            .flat_map(|triangle| triangle.iter().copied())
            .collect();
        let vertex_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("machinewright-viewport-mesh-vertices"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let index_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("machinewright-viewport-mesh-indices"),
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
            });
        self.mesh_cache.insert(
            key.to_owned(),
            CachedMesh {
                vertex_buffer,
                index_buffer,
                index_count: indices.len() as u32,
                last_frame_used: self.frame_counter,
            },
        );
    }

    /// Drops the least-recently-drawn cached meshes once the cache exceeds
    /// `MAX_CACHED_MESHES`, so a long session with many evaluations doesn't
    /// grow GPU memory usage unboundedly. Never evicts a mesh used in the
    /// *current* frame, even if that means temporarily exceeding the limit —
    /// otherwise a scene with more distinct visible meshes than the cap
    /// would evict entries the draw loop below still needs, and panic on
    /// the resulting missing cache entry.
    fn evict_stale_meshes(&mut self) {
        if self.mesh_cache.len() <= MAX_CACHED_MESHES {
            return;
        }
        let current_frame = self.frame_counter;
        let mut entries: Vec<(String, u64)> = self
            .mesh_cache
            .iter()
            .filter(|(_, cached)| cached.last_frame_used != current_frame)
            .map(|(key, cached)| (key.clone(), cached.last_frame_used))
            .collect();
        entries.sort_by_key(|(_, last_used)| *last_used);
        let excess = self.mesh_cache.len().saturating_sub(MAX_CACHED_MESHES);
        for (key, _) in entries.into_iter().take(excess) {
            self.mesh_cache.remove(&key);
        }
    }

    /// The number of distinct mesh geometries currently GPU-resident.
    /// Exposed for tests verifying buffers are retained rather than rebuilt.
    pub fn cached_mesh_count(&self) -> usize {
        self.mesh_cache.len()
    }

    pub fn render_rgba(
        &mut self,
        scene: &Scene,
        state: &ViewportState,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, MeshError> {
        let width = width.max(1);
        let height = height.max(1);
        while self.targets.len() < 3 {
            self.targets
                .push((self.create_target(width, height), [width, height]));
        }
        let target_index = self.next_target % 3;
        self.next_target += 1;
        if self.targets[target_index].1 != [width, height] {
            self.targets[target_index] = (self.create_target(width, height), [width, height]);
        }
        self.frame_counter += 1;
        let visible: Vec<&SceneMesh> = scene
            .meshes
            .iter()
            .filter(|item| state.visible(&item.graph_node_id))
            .collect();
        let transform = state
            .camera
            .view_projection(width as f64 / height as f64)
            .as_mat4()
            .to_cols_array_2d();
        let uniform_size = std::mem::size_of::<DrawUniform>() as u64;
        let uniform_stride = align_up(uniform_size, self.uniform_alignment);
        let draw_count = visible.len().max(1);
        let mut uniform_bytes = vec![0u8; (uniform_stride * draw_count as u64) as usize];
        let mut draws: Vec<(String, u32)> = Vec::with_capacity(visible.len());
        for (index, item) in visible.iter().enumerate() {
            let key = item.digest.clone();
            self.ensure_cached_mesh(&key, &item.mesh);
            let selected = state
                .selected
                .as_ref()
                .is_some_and(|selection| selection.graph_node_id == item.graph_node_id)
                || state.selected_nodes.contains(&item.graph_node_id);
            let color = if selected {
                [1.0, 0.42, 0.08, state.transparency]
            } else {
                [0.22, 0.55, 0.95, state.transparency]
            };
            let (section_plane, has_section) = match state.section_plane {
                Some(plane) => (
                    [
                        plane[0] as f32,
                        plane[1] as f32,
                        plane[2] as f32,
                        plane[3] as f32,
                    ],
                    [1.0, 0.0, 0.0, 0.0],
                ),
                None => ([0.0; 4], [0.0; 4]),
            };
            let uniform = DrawUniform {
                transform,
                color,
                section_plane,
                has_section,
            };
            let offset = (index as u64 * uniform_stride) as usize;
            uniform_bytes[offset..offset + uniform_size as usize]
                .copy_from_slice(bytemuck::bytes_of(&uniform));
            draws.push((key, index as u32));
        }
        self.evict_stale_meshes();
        let uniform_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("machinewright-viewport-draw-uniforms"),
                contents: &uniform_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("machinewright-viewport-draw-bind-group"),
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &uniform_buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(uniform_size),
                }),
            }],
        });
        let texture = &self.targets[target_index].0;
        let view = texture.create_view(&Default::default());
        let depth = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("machinewright-viewport-depth"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let depth_view = depth.create_view(&Default::default());
        let padded_bytes_per_row = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let output = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("machinewright-viewport-readback"),
            size: u64::from(padded_bytes_per_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("machinewright-viewport-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.025,
                            g: 0.035,
                            b: 0.055,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            for (key, uniform_index) in &draws {
                let cached = &self.mesh_cache[key];
                let dynamic_offset = (u64::from(*uniform_index) * uniform_stride) as u32;
                pass.set_bind_group(0, &bind_group, &[dynamic_offset]);
                pass.set_vertex_buffer(0, cached.vertex_buffer.slice(..));
                pass.set_index_buffer(cached.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..cached.index_count, 0, 0..1);
            }
        }
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::ImageCopyBuffer {
                buffer: &output,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let slice = output.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device.poll(wgpu::Maintain::Wait);
        receiver
            .recv()
            .map_err(|error| MeshError::Gpu(error.to_string()))?
            .map_err(|error| MeshError::Gpu(error.to_string()))?;
        let mapped = slice.get_mapped_range();
        let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
        for row in mapped.chunks_exact(padded_bytes_per_row as usize) {
            rgba.extend_from_slice(&row[..width as usize * 4]);
        }
        drop(mapped);
        output.unmap();
        Ok(rgba)
    }

    fn create_target(&self, width: u32, height: u32) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("machinewright-viewport-target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }
}

fn align_up(value: u64, alignment: u64) -> u64 {
    value.div_ceil(alignment.max(1)) * alignment.max(1)
}

#[derive(Debug, Clone, Copy)]
struct Aabb {
    min: DVec3,
    max: DVec3,
}

impl Aabb {
    fn empty() -> Self {
        Self {
            min: DVec3::splat(f64::INFINITY),
            max: DVec3::splat(f64::NEG_INFINITY),
        }
    }

    fn grow(&mut self, point: DVec3) {
        self.min = self.min.min(point);
        self.max = self.max.max(point);
    }

    fn union(&mut self, other: &Aabb) {
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }

    fn centroid(&self) -> DVec3 {
        (self.min + self.max) * 0.5
    }

    /// Slab-method ray/AABB test, one axis at a time. Deliberately not the
    /// usual vectorized `(min - origin) * inv_dir` form: when the ray is
    /// exactly parallel to an axis (`direction[axis] == 0.0`, common for
    /// axis-aligned picking rays) *and* the box touches the ray's origin on
    /// that axis exactly, the vectorized form computes `0.0 * f64::INFINITY`,
    /// which is NaN and silently fails every comparison — dropping real
    /// hits. Handling the zero-direction case explicitly (does this axis's
    /// span contain the origin at all?) avoids that entirely.
    fn intersects_ray(&self, origin: DVec3, direction: DVec3, max_distance: f64) -> bool {
        let mut enter = 0.0f64;
        let mut exit = max_distance;
        for axis in 0..3 {
            let direction_axis = direction[axis];
            let origin_axis = origin[axis];
            let min_axis = self.min[axis];
            let max_axis = self.max[axis];
            if direction_axis == 0.0 {
                if origin_axis < min_axis || origin_axis > max_axis {
                    return false;
                }
                continue;
            }
            let inv = 1.0 / direction_axis;
            let (t1, t2) = {
                let a = (min_axis - origin_axis) * inv;
                let b = (max_axis - origin_axis) * inv;
                if a <= b { (a, b) } else { (b, a) }
            };
            enter = enter.max(t1);
            exit = exit.min(t2);
            // Each axis's `t1`/`t2` is an independent division, so a ray
            // that grazes exactly along a box edge or through a corner
            // (mathematically the same ray-parameter on two axes at once,
            // as happens whenever a pick ray points at a point exactly on
            // a mesh's own boundary) can see `enter` end up a few ULPs
            // above `exit` purely from rounding, even though the ray
            // genuinely enters the box. A tiny relative epsilon absorbs
            // that without meaningfully loosening real rejections.
            let epsilon = 1e-9 * exit.abs().max(1.0);
            if enter > exit + epsilon {
                return false;
            }
        }
        true
    }
}

/// A node in a flat, array-backed bounding volume hierarchy over a mesh's
/// triangles. Leaves hold a contiguous slice of `Bvh::triangle_indices`
/// (`a` = start, `b` = count); internal nodes hold both child node indices
/// (`a` = left, `b` = right) since children are not generally adjacent in
/// the DFS-built node array.
#[derive(Debug, Clone, Copy)]
struct BvhNode {
    bounds: Aabb,
    a: u32,
    b: u32,
    is_leaf: bool,
}

/// Accelerates nearest-hit ray queries against a mesh's triangles from
/// O(triangle count) to roughly O(log triangle count), needed to keep
/// picking responsive on large assemblies (the RFD's reference workload
/// includes a 1,000,000-triangle assembly).
#[derive(Debug, Clone)]
struct Bvh {
    nodes: Vec<BvhNode>,
    triangle_indices: Vec<u32>,
}

/// Triangle count at or below which a subtree becomes a leaf rather than
/// splitting further.
const BVH_LEAF_SIZE: usize = 4;

struct TriangleInfo {
    bounds: Aabb,
    centroid: DVec3,
}

impl Bvh {
    fn build(vertices: &[[f64; 3]], triangles: &[[u32; 3]]) -> Self {
        let infos: Vec<TriangleInfo> = triangles
            .iter()
            .map(|triangle| {
                let mut bounds = Aabb::empty();
                for index in triangle {
                    bounds.grow(DVec3::from_array(vertices[*index as usize]));
                }
                let centroid = bounds.centroid();
                TriangleInfo { bounds, centroid }
            })
            .collect();
        let mut indices: Vec<u32> = (0..infos.len() as u32).collect();
        let mut nodes = Vec::new();
        if !infos.is_empty() {
            Self::build_range(&infos, &mut indices, 0, infos.len(), &mut nodes);
        }
        Self {
            nodes,
            triangle_indices: indices,
        }
    }

    /// Builds the subtree over `indices[start..end]` in place (partitioning
    /// that slice by centroid), appends its nodes to `nodes` in DFS
    /// pre-order, and returns the new subtree root's index in `nodes`.
    fn build_range(
        infos: &[TriangleInfo],
        indices: &mut [u32],
        start: usize,
        end: usize,
        nodes: &mut Vec<BvhNode>,
    ) -> u32 {
        let mut bounds = Aabb::empty();
        for &index in &indices[start..end] {
            bounds.union(&infos[index as usize].bounds);
        }
        let count = end - start;
        let node_index = nodes.len() as u32;
        if count <= BVH_LEAF_SIZE {
            nodes.push(BvhNode {
                bounds,
                a: start as u32,
                b: count as u32,
                is_leaf: true,
            });
            return node_index;
        }
        nodes.push(BvhNode {
            bounds,
            a: 0,
            b: 0,
            is_leaf: false,
        });
        let extent = bounds.max - bounds.min;
        let axis = if extent.x >= extent.y && extent.x >= extent.z {
            0
        } else if extent.y >= extent.z {
            1
        } else {
            2
        };
        let mid = start + count / 2;
        // `count > BVH_LEAF_SIZE >= 1` guarantees `mid` is strictly between
        // `start` and `end`, so both halves are non-empty and strictly
        // smaller than the current range — recursion terminates regardless
        // of how the split axis's centroids are distributed.
        indices[start..end].select_nth_unstable_by(mid - start, |&left, &right| {
            infos[left as usize].centroid[axis]
                .partial_cmp(&infos[right as usize].centroid[axis])
                .expect("mesh coordinates must be finite")
        });
        let left = Self::build_range(infos, indices, start, mid, nodes);
        let right = Self::build_range(infos, indices, mid, end, nodes);
        nodes[node_index as usize].a = left;
        nodes[node_index as usize].b = right;
        node_index
    }

    /// Returns the nearest ray/triangle hit within `upper_bound`, if any, as
    /// `(triangle_index, distance, world_position)`. `section_plane` mirrors
    /// `Scene::pick`'s clipping: a hit on the excluded side of the plane is
    /// skipped entirely rather than being treated as the nearest miss.
    #[allow(clippy::too_many_arguments)]
    fn nearest_hit(
        &self,
        vertices: &[[f64; 3]],
        triangles: &[[u32; 3]],
        origin: DVec3,
        direction: DVec3,
        section_plane: Option<[f64; 4]>,
        upper_bound: f64,
    ) -> Option<(u32, f64, DVec3)> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut best: Option<(u32, f64, DVec3)> = None;
        let mut best_distance = upper_bound;
        let mut stack = vec![0u32];
        while let Some(node_index) = stack.pop() {
            let node = &self.nodes[node_index as usize];
            if !node.bounds.intersects_ray(origin, direction, best_distance) {
                continue;
            }
            if node.is_leaf {
                let range = node.a as usize..(node.a + node.b) as usize;
                for &triangle_index in &self.triangle_indices[range] {
                    let [ia, ib, ic] = triangles[triangle_index as usize];
                    let a = DVec3::from_array(vertices[ia as usize]);
                    let b = DVec3::from_array(vertices[ib as usize]);
                    let c = DVec3::from_array(vertices[ic as usize]);
                    let Some(distance) = ray_triangle(origin, direction, a, b, c) else {
                        continue;
                    };
                    if distance >= best_distance {
                        continue;
                    }
                    let position = origin + direction * distance;
                    if section_plane.is_some_and(|plane| {
                        DVec3::new(plane[0], plane[1], plane[2]).dot(position) + plane[3] < 0.0
                    }) {
                        continue;
                    }
                    best_distance = distance;
                    best = Some((triangle_index, distance, position));
                }
            } else {
                stack.push(node.a);
                stack.push(node.b);
            }
        }
        best
    }
}

#[derive(Debug, Clone)]
pub struct Mesh {
    pub vertices: Vec<[f64; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub bounds: [f64; 6],
    bvh: Bvh,
}

impl Mesh {
    pub fn decode(bytes: &[u8]) -> Result<Self, MeshError> {
        if bytes.len() < 12 || !matches!(&bytes[..4], b"MWM1" | b"MWM2") {
            return Err(MeshError::Header);
        }
        let version = &bytes[..4];
        let vertex_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let triangle_count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let header = if version == b"MWM2" { 36 } else { 12 };
        let vertex_size = 24;
        let expected = header + vertex_count * vertex_size + triangle_count * 12;
        if bytes.len() != expected {
            return Err(MeshError::Length {
                expected,
                actual: bytes.len(),
            });
        }
        let mut offset = header;
        let encoded_bounds = (version == b"MWM2").then(|| {
            let read = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as f64;
            [read(12), read(16), read(20), read(24), read(28), read(32)]
        });
        let mut vertices = Vec::with_capacity(vertex_count);
        let mut normals = Vec::with_capacity(vertex_count);
        for _ in 0..vertex_count {
            if version == b"MWM2" {
                let read = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
                vertices.push([
                    read(offset) as f64,
                    read(offset + 4) as f64,
                    read(offset + 8) as f64,
                ]);
                normals.push([read(offset + 12), read(offset + 16), read(offset + 20)]);
            } else {
                let read = |at: usize| f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
                vertices.push([read(offset), read(offset + 8), read(offset + 16)]);
                normals.push([0.0; 3]);
            }
            offset += 24;
        }
        let mut triangles = Vec::with_capacity(triangle_count);
        for _ in 0..triangle_count {
            let read = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            let triangle = [read(offset), read(offset + 4), read(offset + 8)];
            if triangle.iter().any(|index| *index as usize >= vertex_count) {
                return Err(MeshError::VertexIndex);
            }
            triangles.push(triangle);
            offset += 12;
        }
        if version == b"MWM1" {
            normals = derive_normals(&vertices, &triangles);
        }
        let bounds = encoded_bounds.unwrap_or_else(|| mesh_bounds(&vertices));
        let bvh = Bvh::build(&vertices, &triangles);
        Ok(Self {
            vertices,
            normals,
            triangles,
            bounds,
            bvh,
        })
    }

    /// Places this mesh's geometry (generated in its own local frame) at an
    /// instance's world-space position and orientation, rebuilding bounds
    /// and the BVH to match — both were built from the pre-transform
    /// vertices and would otherwise silently disagree with the geometry
    /// once it moves, breaking picking. A no-op for the identity transform,
    /// which covers the common case of an instance placed at the origin.
    fn place(&mut self, translation: DVec3, rotation: glam::DQuat) {
        if translation == DVec3::ZERO && rotation == glam::DQuat::IDENTITY {
            return;
        }
        for vertex in &mut self.vertices {
            *vertex = (rotation * DVec3::from_array(*vertex) + translation).to_array();
        }
        for normal in &mut self.normals {
            let rotated = rotation
                * DVec3::new(
                    f64::from(normal[0]),
                    f64::from(normal[1]),
                    f64::from(normal[2]),
                );
            *normal = [rotated.x as f32, rotated.y as f32, rotated.z as f32];
        }
        self.bounds = mesh_bounds(&self.vertices);
        self.bvh = Bvh::build(&self.vertices, &self.triangles);
    }
}

fn mesh_bounds(vertices: &[[f64; 3]]) -> [f64; 6] {
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for point in vertices {
        for axis in 0..3 {
            bounds[axis] = bounds[axis].min(point[axis]);
            bounds[axis + 3] = bounds[axis + 3].max(point[axis]);
        }
    }
    if vertices.is_empty() {
        [0.0; 6]
    } else {
        bounds
    }
}

fn derive_normals(vertices: &[[f64; 3]], triangles: &[[u32; 3]]) -> Vec<[f32; 3]> {
    let mut normals = vec![[0.0f64; 3]; vertices.len()];
    for triangle in triangles {
        let [a, b, c] = triangle.map(|index| vertices[index as usize]);
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let normal = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        for index in triangle {
            for axis in 0..3 {
                normals[*index as usize][axis] += normal[axis];
            }
        }
    }
    normals
        .into_iter()
        .map(|normal| {
            let length = normal.iter().map(|value| value * value).sum::<f64>().sqrt();
            if length == 0.0 {
                [0.0, 0.0, 1.0]
            } else {
                [
                    (normal[0] / length) as f32,
                    (normal[1] / length) as f32,
                    (normal[2] / length) as f32,
                ]
            }
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickTarget {
    pub graph_node_id: String,
    pub primitive: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    Perspective,
    Orthographic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AxisView {
    Front,
    Right,
    Top,
}

#[derive(Debug, Clone)]
pub struct Camera {
    pub eye: [f64; 3],
    pub target: [f64; 3],
    pub up: [f64; 3],
    pub projection: Projection,
    pub vertical_fov_radians: f64,
    pub orthographic_height: f64,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            eye: [80.0, -80.0, 60.0],
            target: [0.0, 0.0, 0.0],
            up: [0.0, 0.0, 1.0],
            projection: Projection::Perspective,
            vertical_fov_radians: 45f64.to_radians(),
            orthographic_height: 100.0,
        }
    }
}

impl Camera {
    pub fn set_axis_view(&mut self, view: AxisView) {
        let target = DVec3::from_array(self.target);
        let distance = (DVec3::from_array(self.eye) - target).length().max(1.0);
        let (direction, up) = match view {
            AxisView::Front => (DVec3::NEG_Y, DVec3::Z),
            AxisView::Right => (DVec3::X, DVec3::Z),
            AxisView::Top => (DVec3::Z, DVec3::Y),
        };
        self.eye = (target + direction * distance).to_array();
        self.up = up.to_array();
    }

    /// Radians of separation from either pole (dead-parallel with `up`,
    /// in either direction) that the polar angle in `orbit` is clamped to.
    const MIN_POLAR_ANGLE_RADIANS: f64 = 0.5 * std::f64::consts::PI / 180.0;

    /// Orbits the eye around `target`, expressed in spherical coordinates
    /// around `up` rather than as an incremental rotation composed onto the
    /// previous eye position. Recomputing azimuth/polar angle fresh from a
    /// reference frame that depends only on `up` (never on the current,
    /// possibly near-degenerate, offset) avoids the numerical drift and
    /// direction instability that an iteratively-composed `right` axis
    /// accumulates as the camera approaches either pole — with that
    /// approach, sustained pitching in one direction eventually left the
    /// camera jittering chaotically between near-identical points instead
    /// of continuing to rotate, and the axis it pitched around could even
    /// flip direction step to step right at the boundary.
    pub fn orbit(&mut self, yaw: f64, pitch: f64) {
        let target = DVec3::from_array(self.target);
        let up = DVec3::from_array(self.up).normalize_or(DVec3::Z);
        let offset = DVec3::from_array(self.eye) - target;
        let distance = offset.length().max(1e-6);

        // An orthonormal frame around `up` that stays fixed for as long as
        // `up` does, so it never degrades no matter how the camera has
        // already moved this drag.
        let seed = if up.x.abs() < 0.9 { DVec3::X } else { DVec3::Y };
        let reference = up.cross(seed).normalize();
        let tangent = up.cross(reference);

        let height = offset.dot(up);
        let horizontal = offset - up * height;
        let polar_angle = horizontal.length().atan2(height);
        let azimuth = offset.dot(tangent).atan2(offset.dot(reference));

        let new_azimuth = azimuth + yaw;
        let new_polar_angle = (polar_angle + pitch).clamp(
            Self::MIN_POLAR_ANGLE_RADIANS,
            std::f64::consts::PI - Self::MIN_POLAR_ANGLE_RADIANS,
        );

        let new_offset = (reference * new_azimuth.cos() + tangent * new_azimuth.sin())
            * new_polar_angle.sin()
            + up * new_polar_angle.cos();
        self.eye = (target + new_offset * distance).to_array();
    }

    pub fn pan(&mut self, right: f64, up: f64) {
        let forward = (DVec3::from_array(self.target) - DVec3::from_array(self.eye)).normalize();
        let right_axis = forward.cross(DVec3::from_array(self.up)).normalize();
        let up_axis = right_axis.cross(forward).normalize();
        let delta = right_axis * right + up_axis * up;
        self.eye = (DVec3::from_array(self.eye) + delta).to_array();
        self.target = (DVec3::from_array(self.target) + delta).to_array();
    }

    pub fn zoom(&mut self, factor: f64) {
        match self.projection {
            Projection::Perspective => {
                let target = DVec3::from_array(self.target);
                self.eye =
                    (target + (DVec3::from_array(self.eye) - target) * factor.max(0.01)).to_array();
            }
            Projection::Orthographic => {
                self.orthographic_height = (self.orthographic_height * factor).max(0.001)
            }
        }
    }

    /// The world-space vertical extent visible at the target's distance.
    /// Used to scale a pixel-space drag gesture to world units for panning,
    /// consistently across zoom levels and both projection modes — without
    /// it, a pixel of drag would pan by a fixed world distance regardless
    /// of how zoomed in or out the camera currently is.
    pub fn visible_height_at_target(&self) -> f64 {
        match self.projection {
            Projection::Orthographic => self.orthographic_height,
            Projection::Perspective => {
                let distance =
                    (DVec3::from_array(self.eye) - DVec3::from_array(self.target)).length();
                2.0 * distance * (self.vertical_fov_radians / 2.0).tan()
            }
        }
    }

    pub fn view_projection(&self, aspect: f64) -> DMat4 {
        let view = DMat4::look_at_rh(
            DVec3::from_array(self.eye),
            DVec3::from_array(self.target),
            DVec3::from_array(self.up),
        );
        let projection = match self.projection {
            Projection::Perspective => DMat4::perspective_rh(
                self.vertical_fov_radians,
                aspect.max(0.001),
                0.01,
                100_000.0,
            ),
            Projection::Orthographic => {
                let width = self.orthographic_height * aspect.max(0.001);
                DMat4::orthographic_rh(
                    -width / 2.0,
                    width / 2.0,
                    -self.orthographic_height / 2.0,
                    self.orthographic_height / 2.0,
                    0.01,
                    100_000.0,
                )
            }
        };
        projection * view
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PickHit {
    pub target: PickTarget,
    pub position: [f64; 3],
    pub distance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Measurement {
    pub first: [f64; 3],
    pub second: [f64; 3],
    pub distance: f64,
}

#[derive(Debug, Clone)]
pub struct ViewportState {
    pub camera: Camera,
    pub selected: Option<PickTarget>,
    /// Every graph node owned by the same source mapping as `selected`
    /// (e.g. two instances created by the same call site) — highlighted
    /// alongside it. `selected` alone still drives single-target features
    /// like measurement and hover; this only widens the highlight.
    pub selected_nodes: BTreeSet<String>,
    pub hovered: Option<PickTarget>,
    pub hidden: BTreeSet<String>,
    pub isolated: Option<String>,
    pub transparency: f32,
    pub exploded_distance: f64,
    pub section_plane: Option<[f64; 4]>,
    /// Whether viewport clicks currently advance the measurement state
    /// machine instead of selecting a node. Explicit so the two don't
    /// collide: a click either measures or selects, never both.
    pub measuring: bool,
    measurement_start: Option<[f64; 3]>,
    pub measurement: Option<Measurement>,
}

impl Default for ViewportState {
    fn default() -> Self {
        Self {
            camera: Camera::default(),
            selected: None,
            selected_nodes: BTreeSet::new(),
            hovered: None,
            hidden: BTreeSet::new(),
            isolated: None,
            transparency: 1.0,
            exploded_distance: 0.0,
            section_plane: None,
            measuring: false,
            measurement_start: None,
            measurement: None,
        }
    }
}

impl ViewportState {
    pub fn visible(&self, node_id: &str) -> bool {
        !self.hidden.contains(node_id)
            && self
                .isolated
                .as_deref()
                .is_none_or(|isolated| isolated == node_id)
    }
    pub fn toggle_visibility(&mut self, node_id: &str) {
        if !self.hidden.remove(node_id) {
            self.hidden.insert(node_id.to_owned());
        }
    }
    pub fn isolate(&mut self, node_id: Option<String>) {
        self.isolated = node_id;
    }
    pub fn measure(&mut self, position: [f64; 3]) -> Option<&Measurement> {
        if let Some(first) = self.measurement_start.take() {
            let distance = (DVec3::from_array(position) - DVec3::from_array(first)).length();
            self.measurement = Some(Measurement {
                first,
                second: position,
                distance,
            });
        } else {
            self.measurement = None;
            self.measurement_start = Some(position);
        }
        self.measurement.as_ref()
    }

    /// Clears any in-progress or completed measurement without toggling
    /// measure mode. Used both by an explicit "cancel" action and whenever
    /// measure mode itself is toggled, so switching modes never leaves a
    /// stale pending first point behind.
    pub fn cancel_measurement(&mut self) {
        self.measurement_start = None;
        self.measurement = None;
    }

    /// Applies one viewport action. This is the single entry point every
    /// driver of the viewport goes through — the real UI's buttons and
    /// pointer/wheel handlers, and (headlessly, with no GUI at all) tests —
    /// so camera/visibility behavior can be asserted on directly instead of
    /// only exercised by hand through the app.
    pub fn apply(&mut self, command: ViewportCommand, scene: &Scene) {
        match command {
            ViewportCommand::Fit => scene.fit_camera(&mut self.camera),
            ViewportCommand::Orbit { yaw, pitch } => self.camera.orbit(yaw, pitch),
            ViewportCommand::Pan { right, up } => self.camera.pan(right, up),
            ViewportCommand::Zoom { factor } => self.camera.zoom(factor),
            ViewportCommand::SetAxisView(view) => self.camera.set_axis_view(view),
            ViewportCommand::ToggleProjection => {
                self.camera.projection = match self.camera.projection {
                    Projection::Perspective => Projection::Orthographic,
                    Projection::Orthographic => Projection::Perspective,
                };
            }
            ViewportCommand::ToggleHideSelected => {
                if let Some(id) = self
                    .selected
                    .as_ref()
                    .map(|target| target.graph_node_id.clone())
                {
                    self.toggle_visibility(&id);
                }
            }
            ViewportCommand::ToggleIsolateSelected => {
                let selected = self
                    .selected
                    .as_ref()
                    .map(|target| target.graph_node_id.clone());
                self.isolate(if self.isolated == selected {
                    None
                } else {
                    selected
                });
            }
            ViewportCommand::ToggleSection => {
                self.section_plane = self.section_plane.is_none().then_some([1.0, 0.0, 0.0, 0.0]);
            }
            ViewportCommand::ToggleMeasureMode => {
                self.measuring = !self.measuring;
                self.cancel_measurement();
            }
            ViewportCommand::CancelMeasurement => self.cancel_measurement(),
        }
    }
}

/// Every action the viewport can be driven through, real UI and headless
/// tests alike — the `machinewright-app::AppCommand` pattern applied to the
/// viewport, so the driving surface is data instead of a `fn` pointer or a
/// closure captured over `ViewportState`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ViewportCommand {
    Fit,
    Orbit { yaw: f64, pitch: f64 },
    Pan { right: f64, up: f64 },
    Zoom { factor: f64 },
    SetAxisView(AxisView),
    ToggleProjection,
    ToggleHideSelected,
    ToggleIsolateSelected,
    ToggleSection,
    ToggleMeasureMode,
    CancelMeasurement,
}

/// Radians of orbit per pixel of primary-button drag.
pub const ORBIT_DRAG_SENSITIVITY: f64 = 0.006;
/// Multiplier applied to scroll-wheel delta to produce a zoom factor.
pub const ZOOM_WHEEL_SENSITIVITY: f64 = 0.0015;

/// Translates a primary-button drag delta (screen pixels, Y-down) into an
/// orbit command. Pure so the sign convention — dragging right orbits the
/// camera the same direction a trackball would, dragging up tilts the view
/// up — can be asserted on directly instead of only judged by feel.
pub fn orbit_drag_command(delta_x_px: f64, delta_y_px: f64) -> ViewportCommand {
    ViewportCommand::Orbit {
        yaw: -delta_x_px * ORBIT_DRAG_SENSITIVITY,
        pitch: -delta_y_px * ORBIT_DRAG_SENSITIVITY,
    }
}

/// Translates a secondary-button drag delta (screen pixels, Y-down) into a
/// pan command, scaled by the camera's current visible height so a pixel of
/// drag covers the same fraction of the view regardless of zoom level.
pub fn pan_drag_command(
    delta_x_px: f64,
    delta_y_px: f64,
    visible_height_at_target: f64,
    viewport_height_px: f64,
) -> ViewportCommand {
    let world_per_pixel = visible_height_at_target / viewport_height_px.max(1.0);
    ViewportCommand::Pan {
        right: -delta_x_px * world_per_pixel,
        up: delta_y_px * world_per_pixel,
    }
}

/// Translates a scroll-wheel delta into a zoom command, clamped to a
/// reasonable per-event factor so a single large wheel tick can't blow past
/// the camera's usable range.
pub fn wheel_zoom_command(delta_y: f64) -> ViewportCommand {
    ViewportCommand::Zoom {
        factor: (1.0 + delta_y * ZOOM_WHEEL_SENSITIVITY).clamp(0.5, 1.5),
    }
}

#[derive(Debug, Clone)]
pub struct SceneMesh {
    pub graph_node_id: String,
    /// Shared, not owned: `Scene::clone()` (done on every UI camera/
    /// selection event) is an `Arc` bump per mesh instead of a deep copy of
    /// every vertex/normal/index/BVH node.
    pub mesh: Arc<Mesh>,
    /// A GPU mesh-cache key derived from the evaluator's authoritative
    /// `MeshReference.digest` (cheap to reuse instead of re-hashing
    /// geometry on every draw) plus this instance's placement, when the
    /// node has one. Placement is still baked into `mesh`'s CPU vertices
    /// (unchanged in this pass — see the module-level note on sharing
    /// local-space geometry across instances), so two differently-placed
    /// instances of identical content must still get distinct keys; the
    /// placement is folded into the key precisely to keep that true
    /// without hashing the placed vertices themselves.
    pub digest: String,
}

#[derive(Debug, Clone, Default)]
pub struct Scene {
    pub meshes: Vec<SceneMesh>,
}

impl Scene {
    pub fn load(snapshot: &ProjectSnapshot, artifact_root: &Path) -> Result<Self, MeshError> {
        let meshes = snapshot
            .evaluation()
            .meshes
            .iter()
            .map(|reference| {
                let bytes = fs::read(artifact_root.join(&reference.name))?;
                let mut mesh = Mesh::decode(&bytes)?;
                let mut digest = reference.digest.clone();
                // A part's mesh is tessellated in its own local frame (so
                // e.g. two instances of the same off-the-shelf dowel pin
                // content-address to identical bytes); its graph node's
                // `transform` extension carries where that instance
                // actually sits in the assembly, and has to be applied here
                // or every part renders piled up at the local origin.
                if let Some(node) = snapshot.graph().nodes.get(&reference.graph_node_id) {
                    let transform = node.transform();
                    let translation = DVec3::from_array(transform.translation_mm);
                    let rotation = glam::DQuat::from_euler(
                        glam::EulerRot::XYZ,
                        transform.rotation_degrees_xyz[0].to_radians(),
                        transform.rotation_degrees_xyz[1].to_radians(),
                        transform.rotation_degrees_xyz[2].to_radians(),
                    );
                    mesh.place(translation, rotation);
                    // Placement is baked into the vertices below, so two
                    // differently-placed instances of identical content
                    // must not collide on the same cache key.
                    digest = format!(
                        "{digest}@{:.9},{:.9},{:.9}|{:.9},{:.9},{:.9},{:.9}",
                        translation.x,
                        translation.y,
                        translation.z,
                        rotation.x,
                        rotation.y,
                        rotation.z,
                        rotation.w
                    );
                }
                Ok(SceneMesh {
                    graph_node_id: reference.graph_node_id.clone(),
                    mesh: Arc::new(mesh),
                    digest,
                })
            })
            .collect::<Result<_, MeshError>>()?;
        Ok(Self { meshes })
    }

    pub fn component_ids(&self) -> Vec<String> {
        self.meshes
            .iter()
            .map(|mesh| mesh.graph_node_id.clone())
            .collect()
    }

    pub fn bounds(&self) -> [f64; 6] {
        let mut bounds = [
            f64::INFINITY,
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for item in &self.meshes {
            for axis in 0..3 {
                bounds[axis] = bounds[axis].min(item.mesh.bounds[axis]);
                bounds[axis + 3] = bounds[axis + 3].max(item.mesh.bounds[axis + 3]);
            }
        }
        if self.meshes.is_empty() {
            [0.0; 6]
        } else {
            bounds
        }
    }

    pub fn fit_camera(&self, camera: &mut Camera) {
        let bounds = self.bounds();
        let center = DVec3::new(
            (bounds[0] + bounds[3]) / 2.0,
            (bounds[1] + bounds[4]) / 2.0,
            (bounds[2] + bounds[5]) / 2.0,
        );
        let diagonal = DVec3::new(
            bounds[3] - bounds[0],
            bounds[4] - bounds[1],
            bounds[5] - bounds[2],
        )
        .length()
        .max(1.0);
        camera.target = center.to_array();
        camera.eye = (center + DVec3::new(1.0, -1.0, 0.75).normalize() * diagonal * 1.5).to_array();
        camera.orthographic_height = diagonal * 1.2;
    }

    pub fn pick(
        &self,
        state: &ViewportState,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Option<PickHit> {
        let aspect = width / height.max(1.0);
        let inverse = state.camera.view_projection(aspect).inverse();
        let ndc_x = x / width.max(1.0) * 2.0 - 1.0;
        let ndc_y = 1.0 - y / height.max(1.0) * 2.0;
        let unproject = |z| {
            let point = inverse * DVec4::new(ndc_x, ndc_y, z, 1.0);
            point.truncate() / point.w
        };
        // glam's perspective_rh/orthographic_rh use a 0..1 clip-space depth.
        let origin = unproject(0.0);
        let direction = (unproject(1.0) - origin).normalize();
        let mut nearest: Option<PickHit> = None;
        let mut best_distance = f64::INFINITY;
        for item in &self.meshes {
            if !state.visible(&item.graph_node_id) {
                continue;
            }
            // Threading `best_distance` through each mesh's query (rather
            // than starting fresh per mesh) lets a closer hit already found
            // in an earlier mesh prune this mesh's BVH traversal too.
            let Some((primitive, distance, position)) = item.mesh.bvh.nearest_hit(
                &item.mesh.vertices,
                &item.mesh.triangles,
                origin,
                direction,
                state.section_plane,
                best_distance,
            ) else {
                continue;
            };
            best_distance = distance;
            nearest = Some(PickHit {
                target: PickTarget {
                    graph_node_id: item.graph_node_id.clone(),
                    primitive: Some(primitive),
                },
                position: position.to_array(),
                distance,
            });
        }
        nearest
    }

    pub fn svg(&self, selected: Option<&str>) -> String {
        let points = self.meshes.iter().flat_map(|item| {
            item.mesh
                .vertices
                .iter()
                .map(|[x, y, z]| (x - z * 0.55, -y - z * 0.35))
        });
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for (x, y) in points {
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
        if !min_x.is_finite() {
            return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 600'/>".into();
        }
        let scale = (740.0 / (max_x - min_x).max(1.0)).min(540.0 / (max_y - min_y).max(1.0));
        let project = |[x, y, z]: [f64; 3]| {
            (
                30.0 + (x - z * 0.55 - min_x) * scale,
                30.0 + (-y - z * 0.35 - min_y) * scale,
            )
        };
        let mut polygons = Vec::new();
        for item in &self.meshes {
            for triangle in &item.mesh.triangles {
                let vertices = triangle.map(|index| item.mesh.vertices[index as usize]);
                let depth = vertices.iter().map(|point| point[2]).sum::<f64>() / 3.0;
                let points = vertices
                    .map(project)
                    .map(|(x, y)| format!("{x:.2},{y:.2}"))
                    .join(" ");
                let fill = if selected == Some(item.graph_node_id.as_str()) {
                    "#ff9f43"
                } else {
                    "#70a1ff"
                };
                polygons.push((depth, format!("<polygon points='{points}' fill='{fill}' stroke='#26354a' stroke-width='0.45'/>") ));
            }
        }
        polygons.sort_by(|left, right| left.0.total_cmp(&right.0));
        format!(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 600'><rect width='800' height='600' fill='#151a22'/>{}</svg>",
            polygons
                .into_iter()
                .map(|(_, polygon)| polygon)
                .collect::<String>()
        )
    }
}

fn ray_triangle(origin: DVec3, direction: DVec3, a: DVec3, b: DVec3, c: DVec3) -> Option<f64> {
    let edge1 = b - a;
    let edge2 = c - a;
    let h = direction.cross(edge2);
    let determinant = edge1.dot(h);
    if determinant.abs() < 1e-9 {
        return None;
    }
    let inverse = 1.0 / determinant;
    let s = origin - a;
    let u = inverse * s.dot(h);
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(edge1);
    let v = inverse * direction.dot(q);
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let distance = inverse * edge2.dot(q);
    (distance > 0.0).then_some(distance)
}

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("no compatible GPU adapter is available")]
    NoGpuAdapter,
    #[error("GPU rendering failed: {0}")]
    Gpu(String),
    #[error("mesh I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid Machinewright mesh header")]
    Header,
    #[error("invalid mesh length: expected {expected}, got {actual}")]
    Length { expected: usize, actual: usize },
    #[error("mesh triangle references a missing vertex")]
    VertexIndex,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mwm1() -> Vec<u8> {
        let vertices = [[-1.0f64, -1.0, 0.0], [1.0, -1.0, 0.0], [0.0, 1.0, 0.0]];
        let mut bytes = b"MWM1".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        for vertex in vertices {
            for value in vertex {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        for index in [0u32, 1, 2] {
            bytes.extend_from_slice(&index.to_le_bytes());
        }
        bytes
    }

    fn mwm2() -> Vec<u8> {
        let vertices = [[-1.0f32, -1.0, 0.0], [1.0, -1.0, 0.0], [0.0, 1.0, 0.0]];
        let mut bytes = b"MWM2".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        for value in [-1.0f32, -1.0, 0.0, 1.0, 1.0, 0.0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for vertex in vertices {
            for value in vertex.into_iter().chain([0.0, 0.0, 1.0]) {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        for index in [0u32, 1, 2] {
            bytes.extend_from_slice(&index.to_le_bytes());
        }
        bytes
    }

    fn snapshot_with_mesh(
        dir: &std::path::Path,
        transform: Option<serde_json::Value>,
    ) -> (ProjectSnapshot, std::path::PathBuf) {
        let artifact_root = dir.join("evaluation");
        std::fs::create_dir_all(artifact_root.join("meshes")).unwrap();
        let mesh_bytes = mwm1();
        std::fs::write(artifact_root.join("meshes/tri.mwm"), &mesh_bytes).unwrap();
        let mut node = serde_json::json!({
            "node_id": "part", "instance_key": "part", "kind": "part",
            "definition_id": "test.part", "parameters": {}
        });
        if let Some(transform) = transform {
            node["transform"] = transform;
        }
        let snapshot = serde_json::json!({
            "schema_version": "1.0",
            "generation": 1,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {"nodes": [node], "containment": []},
            "source_mappings": [], "dependencies": [], "diagnostics": [],
            "meshes": [{
                "encoding": "mwm1", "graph_node_id": "part", "digest": "sha256:irrelevant",
                "name": "meshes/tri.mwm", "byte_size": mesh_bytes.len(),
                "vertex_count": 3, "triangle_count": 1
            }],
            "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        });
        let snapshot_path = artifact_root.join("evaluation-snapshot.json");
        std::fs::write(&snapshot_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
        (
            ProjectSnapshot::load(&snapshot_path).unwrap(),
            artifact_root,
        )
    }

    #[test]
    fn scene_load_leaves_mesh_local_when_node_has_no_transform() {
        let dir = tempfile::tempdir().unwrap();
        let (snapshot, artifact_root) = snapshot_with_mesh(dir.path(), None);
        let scene = Scene::load(&snapshot, &artifact_root).unwrap();
        let mesh = &scene.meshes[0].mesh;
        assert_eq!(mesh.vertices[0], [-1.0, -1.0, 0.0]);
        assert_eq!(mesh.bounds, [-1.0, -1.0, 0.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn scene_load_places_mesh_at_its_instance_translation_and_keeps_picking_consistent() {
        // Regression test for a real bug: identical off-the-shelf part
        // instances (e.g. two dowel pins) tessellate to the same mesh bytes
        // in their own local frame, and only the graph node's `transform`
        // extension says where each instance actually sits in the
        // assembly. `Scene::load` must apply it — otherwise every instance
        // renders piled up at the local origin instead of at its assembly
        // position, and the BVH built from it must be rebuilt afterward, or
        // picking silently disagrees with the geometry it just moved.
        let dir = tempfile::tempdir().unwrap();
        let transform = serde_json::json!({
            "translation_mm": ["10", "0", "0"],
            "rotation_degrees_xyz": ["0", "0", "0"],
        });
        let (snapshot, artifact_root) = snapshot_with_mesh(dir.path(), Some(transform));
        let scene = Scene::load(&snapshot, &artifact_root).unwrap();
        let mesh = &scene.meshes[0].mesh;
        assert_eq!(mesh.vertices[0], [9.0, -1.0, 0.0]);
        assert_eq!(mesh.bounds, [9.0, -1.0, 0.0, 11.0, 1.0, 0.0]);

        let mut state = ViewportState::default();
        state.camera.eye = [10.0, 0.0, 5.0];
        state.camera.target = [10.0, 0.0, 0.0];
        state.camera.up = [0.0, 1.0, 0.0];
        assert!(
            scene.pick(&state, 50.0, 50.0, 100.0, 100.0).is_some(),
            "picking at the mesh's new world position must hit it \
             (a stale, un-rebuilt BVH would miss here)"
        );

        state.camera.eye = [0.0, 0.0, 5.0];
        state.camera.target = [0.0, 0.0, 0.0];
        assert!(
            scene.pick(&state, 50.0, 50.0, 100.0, 100.0).is_none(),
            "nothing should remain at the mesh's old local-frame position"
        );
    }

    #[test]
    fn orbit_never_lets_the_eye_target_offset_reach_either_pole() {
        // Regression test for a real bug: repeatedly pitching an orbit
        // camera in the same direction — exactly what a sustained vertical
        // drag does, one small `PointerMove` step at a time — walked the
        // eye-target offset toward becoming parallel with `up`, with
        // nothing to stop it. Once close enough, the `right` axis pitch
        // rotates around underflowed toward zero and successive steps
        // jittered chaotically between near-identical points instead of
        // continuing to rotate: the drag looked completely stuck. The fix
        // is a hard clamp — `Camera::orbit` must never produce an offset
        // whose angle to `up` crosses within `MIN_POLAR_ANGLE_RADIANS` of
        // either pole, for any starting orientation or amount of pitch.
        let lower_bound = Camera::MIN_POLAR_ANGLE_RADIANS;
        let upper_bound = std::f64::consts::PI - Camera::MIN_POLAR_ANGLE_RADIANS;
        let starts: [([f64; 3], [f64; 3], [f64; 3]); 3] = [
            (
                [50.60029885190836, -50.60029885190836, 59.950224138931276],
                [0.0, 0.0, 22.0],
                [0.0, 0.0, 1.0],
            ),
            ([0.0, -80.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 103.0], [0.0, 0.0, 22.0], [0.0, 1.0, 0.0]),
        ];
        for (eye, target, up) in starts {
            let mut camera = Camera {
                eye,
                target,
                up,
                ..Camera::default()
            };
            // A combined yaw+pitch drag, repeated well beyond a full
            // rotation's worth of pitch, so an unclamped implementation
            // would cross a pole (or several) many times over.
            for _ in 0..200 {
                camera.orbit(0.017, -0.048);
                let offset = DVec3::from_array(camera.eye) - DVec3::from_array(camera.target);
                let polar_angle = offset.angle_between(DVec3::from_array(camera.up));
                assert!(
                    (lower_bound - 1e-6..=upper_bound + 1e-6).contains(&polar_angle),
                    "orbiting from eye={eye:?} must never reach the pole: \
                     polar_angle={polar_angle}"
                );
            }
        }
    }

    #[test]
    fn visible_height_at_target_matches_orthographic_height_and_shrinks_when_zoomed_in() {
        let mut camera = Camera {
            projection: Projection::Orthographic,
            orthographic_height: 42.0,
            ..Camera::default()
        };
        assert_eq!(camera.visible_height_at_target(), 42.0);

        camera.projection = Projection::Perspective;
        camera.eye = [0.0, 0.0, 10.0];
        camera.target = [0.0, 0.0, 0.0];
        let far = camera.visible_height_at_target();
        camera.zoom(0.5); // moves the eye toward the target, halving distance
        let near = camera.visible_height_at_target();
        assert!(
            near < far,
            "zooming in should shrink the visible height at the target"
        );
        assert!((near - far / 2.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_both_mesh_versions() {
        let old = Mesh::decode(&mwm1()).unwrap();
        assert_eq!(old.bounds, [-1.0, -1.0, 0.0, 1.0, 1.0, 0.0]);
        assert_eq!(old.normals[0], [0.0, 0.0, 1.0]);
        let current = Mesh::decode(&mwm2()).unwrap();
        assert_eq!(current.bounds, old.bounds);
        assert_eq!(current.normals[2], [0.0, 0.0, 1.0]);
    }

    #[test]
    fn rejects_out_of_range_triangle_indices() {
        let mut bytes = mwm1();
        let index = bytes.len() - 4;
        bytes[index..].copy_from_slice(&9u32.to_le_bytes());
        assert!(matches!(Mesh::decode(&bytes), Err(MeshError::VertexIndex)));
    }

    #[test]
    #[ignore = "requires a native GPU; run explicitly on the acceptance platform"]
    fn gpu_depth_is_independent_of_draw_order_and_selection_updates() {
        let mut renderer = pollster::block_on(OffscreenRenderer::new()).unwrap();
        let near = SceneMesh {
            graph_node_id: "near".into(),
            mesh: Arc::new(Mesh::decode(&mwm2()).unwrap()),
            digest: "near".into(),
        };
        // A separate decode (not `near.clone()`) since `mesh` is now shared
        // via `Arc` — cloning `near` would give `far` a handle to the same
        // underlying geometry, and mutating through it would move `near`
        // too.
        let mut far_mesh = Mesh::decode(&mwm2()).unwrap();
        for vertex in &mut far_mesh.vertices {
            vertex[2] -= 1.0;
        }
        let far = SceneMesh {
            graph_node_id: "far".into(),
            mesh: Arc::new(far_mesh),
            digest: "far".into(),
        };
        let mut state = ViewportState::default();
        state.camera.eye = [0.0, 0.0, 5.0];
        state.camera.up = [0.0, 1.0, 0.0];
        state.selected = Some(PickTarget {
            graph_node_id: "near".into(),
            primitive: None,
        });
        let mut scene = Scene {
            meshes: vec![near, far],
        };
        // Non-aligned width exercises removal of GPU row padding.
        let first = renderer.render_rgba(&scene, &state, 65, 65).unwrap();
        scene.meshes.reverse();
        let reversed = renderer.render_rgba(&scene, &state, 65, 65).unwrap();
        assert_eq!(first, reversed);
        assert_eq!(first.len(), 65 * 65 * 4);
        let center = (32 * 65 + 32) * 4;
        assert!(
            first[center] > first[center + 2],
            "near selected surface must be orange"
        );
        state.selected = None;
        let unselected = renderer.render_rgba(&scene, &state, 65, 65).unwrap();
        assert!(unselected[center + 2] > unselected[center]);
        state.section_plane = Some([1.0, 0.0, 0.0, 0.0]);
        let sectioned = renderer.render_rgba(&scene, &state, 65, 65).unwrap();
        let left = (32 * 65 + 29) * 4;
        let right = (32 * 65 + 35) * 4;
        assert_ne!(&sectioned[left..left + 4], &unselected[left..left + 4]);
        assert_eq!(&sectioned[right..right + 4], &unselected[right..right + 4]);
        let empty = renderer
            .render_rgba(&Scene::default(), &state, 1, 1)
            .unwrap();
        assert_eq!(empty.len(), 4);
    }

    #[test]
    #[ignore = "requires a native GPU; run explicitly on the acceptance platform"]
    fn gpu_buffers_are_retained_across_frames_and_rebuilt_only_on_content_change() {
        let mut renderer = pollster::block_on(OffscreenRenderer::new()).unwrap();
        let mesh_a = SceneMesh {
            graph_node_id: "a".into(),
            mesh: Arc::new(Mesh::decode(&mwm2()).unwrap()),
            digest: "a".into(),
        };
        let scene = Scene {
            meshes: vec![mesh_a],
        };
        let mut state = ViewportState::default();
        state.camera.eye = [0.0, 0.0, 5.0];
        state.camera.up = [0.0, 1.0, 0.0];

        assert_eq!(renderer.cached_mesh_count(), 0);
        renderer.render_rgba(&scene, &state, 32, 32).unwrap();
        assert_eq!(
            renderer.cached_mesh_count(),
            1,
            "first draw of a mesh must upload it"
        );

        // Camera and selection changes alone must not evict or rebuild the
        // cached geometry — only the per-draw uniform should change.
        state.camera.orbit(0.4, 0.1);
        state.selected = Some(PickTarget {
            graph_node_id: "a".into(),
            primitive: None,
        });
        renderer.render_rgba(&scene, &state, 32, 32).unwrap();
        assert_eq!(
            renderer.cached_mesh_count(),
            1,
            "unchanged mesh content must be reused, not re-uploaded"
        );

        // Different geometry for the same graph node (e.g. after a
        // parameter edit) must be recognized as new content and uploaded
        // separately, not silently reuse the stale cached buffer.
        let mut edited_mesh = Mesh::decode(&mwm2()).unwrap();
        for vertex in &mut edited_mesh.vertices {
            vertex[0] += 5.0;
        }
        let edited_scene = Scene {
            meshes: vec![SceneMesh {
                graph_node_id: "a".into(),
                mesh: Arc::new(edited_mesh),
                digest: "a-edited".into(),
            }],
        };
        renderer.render_rgba(&edited_scene, &state, 32, 32).unwrap();
        assert_eq!(
            renderer.cached_mesh_count(),
            2,
            "changed geometry must be cached separately from the original"
        );
    }

    #[test]
    #[ignore = "requires a native GPU; run explicitly on the acceptance platform"]
    fn gpu_mesh_cache_evicts_the_least_recently_drawn_entries_when_full() {
        let mut renderer = pollster::block_on(OffscreenRenderer::new()).unwrap();
        let mut state = ViewportState::default();
        state.camera.eye = [0.0, 0.0, 5.0];
        state.camera.up = [0.0, 1.0, 0.0];
        // One draw per distinct mesh, each with a unique digest so every
        // call is a cache miss, well past the eviction bound.
        for step in 0..300 {
            let mut mesh = Mesh::decode(&mwm2()).unwrap();
            for vertex in &mut mesh.vertices {
                vertex[0] += step as f64;
            }
            let scene = Scene {
                meshes: vec![SceneMesh {
                    graph_node_id: "a".into(),
                    mesh: Arc::new(mesh),
                    digest: format!("step-{step}"),
                }],
            };
            renderer.render_rgba(&scene, &state, 8, 8).unwrap();
        }
        assert!(
            renderer.cached_mesh_count() <= 256,
            "cache must not grow unboundedly across many distinct evaluations"
        );
    }

    #[test]
    #[ignore = "requires a native GPU; run explicitly on the acceptance platform"]
    fn gpu_render_does_not_evict_meshes_the_current_frame_still_needs() {
        // A single frame with more distinct visible meshes than
        // `MAX_CACHED_MESHES` (256) must not panic: the mesh cache can't
        // evict entries this very draw call is about to use just because
        // the frame as a whole exceeds the soft cap.
        let mut renderer = pollster::block_on(OffscreenRenderer::new()).unwrap();
        let mut state = ViewportState::default();
        state.camera.eye = [0.0, 0.0, 500.0];
        state.camera.up = [0.0, 1.0, 0.0];
        let meshes = (0..300)
            .map(|index| {
                let mut mesh = Mesh::decode(&mwm2()).unwrap();
                for vertex in &mut mesh.vertices {
                    vertex[0] += index as f64;
                }
                SceneMesh {
                    graph_node_id: format!("part-{index}"),
                    mesh: Arc::new(mesh),
                    digest: format!("part-{index}"),
                }
            })
            .collect();
        let scene = Scene { meshes };
        renderer.render_rgba(&scene, &state, 8, 8).unwrap();
        assert_eq!(renderer.cached_mesh_count(), 300);
    }

    #[test]
    fn camera_and_component_picking_are_independent_of_python() {
        let mesh = Mesh::decode(&mwm2()).unwrap();
        let scene = Scene {
            meshes: vec![SceneMesh {
                graph_node_id: "component/plate".into(),
                mesh: Arc::new(mesh),
                digest: "component/plate".into(),
            }],
        };
        let mut state = ViewportState::default();
        state.camera.eye = [0.0, 0.0, 5.0];
        state.camera.target = [0.0, 0.0, 0.0];
        state.camera.up = [0.0, 1.0, 0.0];
        let hit = scene.pick(&state, 50.0, 50.0, 100.0, 100.0).unwrap();
        assert_eq!(hit.target.graph_node_id, "component/plate");
        state.toggle_visibility("component/plate");
        assert!(scene.pick(&state, 50.0, 50.0, 100.0, 100.0).is_none());
    }

    fn mesh_from(vertices: Vec<[f64; 3]>, triangles: Vec<[u32; 3]>) -> Mesh {
        let bounds = mesh_bounds(&vertices);
        let bvh = Bvh::build(&vertices, &triangles);
        let normals = vec![[0.0, 0.0, 1.0]; vertices.len()];
        Mesh {
            vertices,
            normals,
            triangles,
            bounds,
            bvh,
        }
    }

    /// A flat grid of triangles at z=0 spanning `[-half_extent, half_extent]`
    /// in x and y, plus one small triangle raised to z=1.0 near the origin
    /// (nearer to a camera looking down from +z) — enough triangles that a
    /// buggy BVH split would very likely miss or misidentify the nearest
    /// hit, unlike a mesh small enough to fit in a single leaf.
    fn grid_and_spike_mesh(half_extent: f64, divisions: usize) -> Mesh {
        let stride = divisions + 1;
        let step = (half_extent * 2.0) / divisions as f64;
        let mut vertices = Vec::with_capacity(stride * stride);
        for row in 0..stride {
            for col in 0..stride {
                vertices.push([
                    -half_extent + col as f64 * step,
                    -half_extent + row as f64 * step,
                    0.0,
                ]);
            }
        }
        let mut triangles = Vec::with_capacity(divisions * divisions * 2);
        for row in 0..divisions {
            for col in 0..divisions {
                let a = (row * stride + col) as u32;
                let b = a + 1;
                let c = a + stride as u32;
                let d = c + 1;
                triangles.push([a, b, d]);
                triangles.push([a, d, c]);
            }
        }
        let spike_base = vertices.len() as u32;
        vertices.push([-0.1, -0.1, 1.0]);
        vertices.push([0.1, -0.1, 1.0]);
        vertices.push([0.0, 0.1, 1.0]);
        triangles.push([spike_base, spike_base + 1, spike_base + 2]);
        mesh_from(vertices, triangles)
    }

    /// Reference implementation mirroring the pre-BVH linear scan, used to
    /// differentially test the BVH against ground truth across many rays.
    fn brute_force_nearest_hit(
        mesh: &Mesh,
        origin: DVec3,
        direction: DVec3,
        section_plane: Option<[f64; 4]>,
    ) -> Option<(u32, f64)> {
        let mut best: Option<(u32, f64)> = None;
        for (index, triangle) in mesh.triangles.iter().enumerate() {
            let [a, b, c] = triangle.map(|i| DVec3::from_array(mesh.vertices[i as usize]));
            let Some(distance) = ray_triangle(origin, direction, a, b, c) else {
                continue;
            };
            let position = origin + direction * distance;
            if section_plane.is_some_and(|plane| {
                DVec3::new(plane[0], plane[1], plane[2]).dot(position) + plane[3] < 0.0
            }) {
                continue;
            }
            if best.is_none_or(|(_, best_distance)| distance < best_distance) {
                best = Some((index as u32, distance));
            }
        }
        best
    }

    #[test]
    fn bvh_picking_prefers_the_nearer_spike_and_falls_through_when_it_is_clipped() {
        let mesh = grid_and_spike_mesh(10.0, 40);
        let scene = Scene {
            meshes: vec![SceneMesh {
                graph_node_id: "surface".into(),
                mesh: Arc::new(mesh),
                digest: "surface".into(),
            }],
        };
        let mut state = ViewportState::default();
        state.camera.eye = [0.0, 0.0, 5.0];
        state.camera.target = [0.0, 0.0, 0.0];
        state.camera.up = [0.0, 1.0, 0.0];

        let hit = scene.pick(&state, 50.0, 50.0, 100.0, 100.0).unwrap();
        assert!(
            (hit.position[2] - 1.0).abs() < 1e-6,
            "expected the nearer spike triangle to win over the grid beneath it, got z={}",
            hit.position[2]
        );

        // Clip out the spike (z=1) while keeping the grid (z=0) visible: the
        // BVH must not report "no hit" just because the nearest candidate by
        // distance was rejected — it must keep searching and surface the
        // grid hit beneath it, exactly like the linear scan did.
        state.section_plane = Some([0.0, 0.0, -1.0, 0.5]);
        let hit = scene.pick(&state, 50.0, 50.0, 100.0, 100.0).unwrap();
        assert!(
            hit.position[2].abs() < 1e-6,
            "expected the clipped spike to fall through to the grid, got z={}",
            hit.position[2]
        );
    }

    #[test]
    fn bvh_picking_matches_a_brute_force_scan_across_many_rays() {
        let mesh = grid_and_spike_mesh(10.0, 40);
        let origin = DVec3::new(0.0, 0.0, 5.0);
        let section_planes = [None, Some([0.0, 0.0, -1.0, 0.5])];
        for &section_plane in &section_planes {
            for step_x in -6..=6 {
                for step_y in -6..=6 {
                    // Rays toward points spread across and beyond the grid's
                    // extent, so both hits and misses are exercised.
                    let target = DVec3::new(step_x as f64 * 2.0, step_y as f64 * 2.0, 0.0);
                    let direction = (target - origin).normalize();
                    let expected = brute_force_nearest_hit(&mesh, origin, direction, section_plane);
                    let actual = mesh
                        .bvh
                        .nearest_hit(
                            &mesh.vertices,
                            &mesh.triangles,
                            origin,
                            direction,
                            section_plane,
                            f64::INFINITY,
                        )
                        .map(|(index, distance, _)| (index, distance));
                    match (expected, actual) {
                        (None, None) => {}
                        (Some((_, expected_distance)), Some((_, actual_distance))) => {
                            assert!(
                                (expected_distance - actual_distance).abs() < 1e-9,
                                "distance mismatch at ({step_x}, {step_y}) section={section_plane:?}: expected {expected_distance}, got {actual_distance}"
                            );
                        }
                        (expected, actual) => panic!(
                            "hit/miss mismatch at ({step_x}, {step_y}) section={section_plane:?}: expected {expected:?}, got {actual:?}"
                        ),
                    }
                }
            }
        }
    }

    #[test]
    fn orbit_drag_right_yaws_the_camera_toward_negative_yaw() {
        let command = orbit_drag_command(10.0, 0.0);
        assert_eq!(
            command,
            ViewportCommand::Orbit {
                yaw: -10.0 * ORBIT_DRAG_SENSITIVITY,
                pitch: 0.0,
            }
        );
    }

    #[test]
    fn orbit_drag_down_pitches_the_camera_toward_negative_pitch() {
        let command = orbit_drag_command(0.0, 10.0);
        assert_eq!(
            command,
            ViewportCommand::Orbit {
                yaw: 0.0,
                pitch: -10.0 * ORBIT_DRAG_SENSITIVITY,
            }
        );
    }

    #[test]
    fn pan_drag_scales_by_visible_height_and_flips_x_but_not_y() {
        let command = pan_drag_command(10.0, 10.0, 600.0, 600.0);
        assert_eq!(
            command,
            ViewportCommand::Pan {
                right: -10.0,
                up: 10.0,
            }
        );
    }

    #[test]
    fn pan_drag_is_more_sensitive_when_zoomed_out() {
        let zoomed_in = pan_drag_command(10.0, 0.0, 60.0, 600.0);
        let zoomed_out = pan_drag_command(10.0, 0.0, 600.0, 600.0);
        let ViewportCommand::Pan { right: near, .. } = zoomed_in else {
            unreachable!()
        };
        let ViewportCommand::Pan { right: far, .. } = zoomed_out else {
            unreachable!()
        };
        assert!(far.abs() > near.abs());
    }

    #[test]
    fn wheel_zoom_scroll_forward_zooms_in_and_is_clamped() {
        let command = wheel_zoom_command(-10_000.0);
        assert_eq!(command, ViewportCommand::Zoom { factor: 0.5 });
    }

    #[test]
    fn wheel_zoom_scroll_backward_zooms_out_and_is_clamped() {
        let command = wheel_zoom_command(10_000.0);
        assert_eq!(command, ViewportCommand::Zoom { factor: 1.5 });
    }

    #[test]
    fn apply_fit_uses_the_scene_bounds() {
        let mesh = Mesh::decode(&mwm1()).unwrap();
        let scene = Scene {
            meshes: vec![SceneMesh {
                graph_node_id: "n".into(),
                mesh: Arc::new(mesh),
                digest: "n".into(),
            }],
        };
        let mut state = ViewportState::default();
        let before = state.camera.eye;
        state.apply(ViewportCommand::Fit, &scene);
        assert_ne!(state.camera.eye, before);
    }

    #[test]
    fn apply_toggle_projection_flips_between_perspective_and_orthographic() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        assert_eq!(state.camera.projection, Projection::Perspective);
        state.apply(ViewportCommand::ToggleProjection, &scene);
        assert_eq!(state.camera.projection, Projection::Orthographic);
        state.apply(ViewportCommand::ToggleProjection, &scene);
        assert_eq!(state.camera.projection, Projection::Perspective);
    }

    #[test]
    fn apply_toggle_hide_selected_hides_and_reveals_the_selected_node() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        state.selected = Some(PickTarget {
            graph_node_id: "wheel".into(),
            primitive: None,
        });
        state.apply(ViewportCommand::ToggleHideSelected, &scene);
        assert!(!state.visible("wheel"));
        state.apply(ViewportCommand::ToggleHideSelected, &scene);
        assert!(state.visible("wheel"));
    }

    #[test]
    fn apply_toggle_isolate_selected_toggles_isolation_on_and_off() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        state.selected = Some(PickTarget {
            graph_node_id: "wheel".into(),
            primitive: None,
        });
        state.apply(ViewportCommand::ToggleIsolateSelected, &scene);
        assert_eq!(state.isolated.as_deref(), Some("wheel"));
        state.apply(ViewportCommand::ToggleIsolateSelected, &scene);
        assert_eq!(state.isolated, None);
    }

    #[test]
    fn apply_toggle_section_toggles_the_section_plane_on_and_off() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        assert_eq!(state.section_plane, None);
        state.apply(ViewportCommand::ToggleSection, &scene);
        assert_eq!(state.section_plane, Some([1.0, 0.0, 0.0, 0.0]));
        state.apply(ViewportCommand::ToggleSection, &scene);
        assert_eq!(state.section_plane, None);
    }

    #[test]
    fn apply_toggle_measure_mode_toggles_measuring_and_clears_pending_state() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        assert!(!state.measuring);
        state.apply(ViewportCommand::ToggleMeasureMode, &scene);
        assert!(state.measuring);
        state.measure([0.0, 0.0, 0.0]);
        assert!(state.measurement.is_none());
        state.apply(ViewportCommand::ToggleMeasureMode, &scene);
        assert!(!state.measuring);
        assert!(state.measurement.is_none());
    }

    #[test]
    fn apply_cancel_measurement_clears_a_pending_first_point_without_toggling_mode() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        state.measuring = true;
        state.measure([0.0, 0.0, 0.0]);
        state.apply(ViewportCommand::CancelMeasurement, &scene);
        assert!(state.measuring);
        let measurement = state.measure([1.0, 0.0, 0.0]);
        assert!(
            measurement.is_none(),
            "cancel should have discarded the pending first point"
        );
    }

    #[test]
    fn apply_cancel_measurement_clears_a_completed_measurement() {
        let mut state = ViewportState::default();
        let scene = Scene::default();
        state.measuring = true;
        state.measure([0.0, 0.0, 0.0]);
        state.measure([3.0, 0.0, 0.0]);
        assert!(state.measurement.is_some());
        state.apply(ViewportCommand::CancelMeasurement, &scene);
        assert!(state.measurement.is_none());
    }
}
