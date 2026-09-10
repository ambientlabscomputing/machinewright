use std::{collections::BTreeSet, fs, path::Path};

use glam::{DMat4, DVec3, DVec4};
use machinewright_model::ProjectSnapshot;
use thiserror::Error;
use wgpu::util::DeviceExt;

const VIEWPORT_SHADER: &str = r#"
struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) section_distance: f32,
};

@vertex
fn vertex_main(@location(0) position: vec4<f32>, @location(1) color: vec4<f32>, @location(2) section_distance: f32) -> VertexOut {
    var out: VertexOut;
    out.position = position;
    out.color = color;
    out.section_distance = section_distance;
    return out;
}

@fragment
fn fragment_main(in: VertexOut) -> @location(0) vec4<f32> {
    if in.section_distance < 0.0 { discard; }
    return in.color;
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuVertex {
    position: [f32; 4],
    color: [f32; 4],
    section_distance: f32,
}

/// Framework-neutral offscreen renderer. UI adapters submit scene updates from a
/// background thread and display only the newest completed RGBA frame.
pub struct OffscreenRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    targets: Vec<(wgpu::Texture, [u32; 2])>,
    next_target: usize,
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
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("machinewright-viewport-layout"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });
        let attributes = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32];
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
        Ok(Self {
            device,
            queue,
            pipeline,
            targets: Vec::new(),
            next_target: 0,
        })
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
        let (vertices, indices) = gpu_geometry(scene, state, width as f64 / height as f64);
        let vertex_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("machinewright-viewport-vertices"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let index_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("machinewright-viewport-indices"),
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
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
            pass.set_vertex_buffer(0, vertex_buffer.slice(..));
            pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
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

fn gpu_geometry(scene: &Scene, state: &ViewportState, aspect: f64) -> (Vec<GpuVertex>, Vec<u32>) {
    let transform = state.camera.view_projection(aspect);
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for item in &scene.meshes {
        if !state.visible(&item.graph_node_id) {
            continue;
        }
        let selected = state
            .selected
            .as_ref()
            .is_some_and(|selection| selection.graph_node_id == item.graph_node_id);
        let color = if selected {
            [1.0, 0.42, 0.08, state.transparency]
        } else {
            [0.22, 0.55, 0.95, state.transparency]
        };
        let base = vertices.len() as u32;
        vertices.extend(item.mesh.vertices.iter().map(|position| {
            let clip = transform * DVec4::new(position[0], position[1], position[2], 1.0);
            GpuVertex {
                position: clip.as_vec4().to_array(),
                color,
                section_distance: state.section_plane.map_or(1.0, |plane| {
                    (plane[0] * position[0]
                        + plane[1] * position[1]
                        + plane[2] * position[2]
                        + plane[3]) as f32
                }),
            }
        }));
        for triangle in &item.mesh.triangles {
            indices.extend(triangle.map(|index| base + index));
        }
    }
    (vertices, indices)
}

#[derive(Debug, Clone)]
pub struct Mesh {
    pub vertices: Vec<[f64; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    pub bounds: [f64; 6],
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
        Ok(Self {
            vertices,
            normals,
            triangles,
            bounds,
        })
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

    pub fn orbit(&mut self, yaw: f64, pitch: f64) {
        let target = DVec3::from_array(self.target);
        let offset = DVec3::from_array(self.eye) - target;
        let yaw_rotation = glam::DQuat::from_axis_angle(DVec3::Z, yaw);
        let right = offset.cross(DVec3::from_array(self.up)).normalize_or_zero();
        let pitch_rotation = glam::DQuat::from_axis_angle(right, pitch);
        self.eye = (target + pitch_rotation * (yaw_rotation * offset)).to_array();
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
    pub hovered: Option<PickTarget>,
    pub hidden: BTreeSet<String>,
    pub isolated: Option<String>,
    pub transparency: f32,
    pub exploded_distance: f64,
    pub section_plane: Option<[f64; 4]>,
    measurement_start: Option<[f64; 3]>,
    pub measurement: Option<Measurement>,
}

impl Default for ViewportState {
    fn default() -> Self {
        Self {
            camera: Camera::default(),
            selected: None,
            hovered: None,
            hidden: BTreeSet::new(),
            isolated: None,
            transparency: 1.0,
            exploded_distance: 0.0,
            section_plane: None,
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
}

#[derive(Debug, Clone)]
pub struct SceneMesh {
    pub graph_node_id: String,
    pub mesh: Mesh,
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
                Ok(SceneMesh {
                    graph_node_id: reference.graph_node_id.clone(),
                    mesh: Mesh::decode(&bytes)?,
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
        for item in &self.meshes {
            if !state.visible(&item.graph_node_id) {
                continue;
            }
            for (primitive, triangle) in item.mesh.triangles.iter().enumerate() {
                let [a, b, c] =
                    triangle.map(|index| DVec3::from_array(item.mesh.vertices[index as usize]));
                let Some(distance) = ray_triangle(origin, direction, a, b, c) else {
                    continue;
                };
                let position = origin + direction * distance;
                if state.section_plane.is_some_and(|plane| {
                    DVec3::new(plane[0], plane[1], plane[2]).dot(position) + plane[3] < 0.0
                }) {
                    continue;
                }
                if nearest.as_ref().is_none_or(|hit| distance < hit.distance) {
                    nearest = Some(PickHit {
                        target: PickTarget {
                            graph_node_id: item.graph_node_id.clone(),
                            primitive: Some(primitive as u32),
                        },
                        position: position.to_array(),
                        distance,
                    });
                }
            }
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
            mesh: Mesh::decode(&mwm2()).unwrap(),
        };
        let mut far = near.clone();
        far.graph_node_id = "far".into();
        for vertex in &mut far.mesh.vertices {
            vertex[2] -= 1.0;
        }
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
    fn camera_and_component_picking_are_independent_of_python() {
        let mesh = Mesh::decode(&mwm2()).unwrap();
        let scene = Scene {
            meshes: vec![SceneMesh {
                graph_node_id: "component/plate".into(),
                mesh,
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
}
