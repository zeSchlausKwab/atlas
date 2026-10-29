use std::cell::Cell;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram, WebGlShader,
    WebGlUniformLocation,
};

const COLORS: [[f32; 3]; 8] = [
    [0.72, 0.78, 0.62],
    [0.47, 0.68, 0.73],
    [0.73, 0.66, 0.56],
    [0.94, 0.89, 0.77],
    [0.79, 0.47, 0.26],
    [0.68, 0.64, 0.47],
    [0.45, 0.49, 0.46],
    [0.39, 0.40, 0.30],
];
struct Feature {
    class: usize,
    kind: u8,
    height: f32,
    min_height: f32,
    rings: Vec<Vec<[f32; 2]>>,
}
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).ok_or("Tile length overflow")?;
        let value = self.bytes.get(self.pos..end).ok_or("Truncated tile")?;
        self.pos = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}
fn decode(bytes: &[u8]) -> Result<Vec<Feature>, String> {
    let mut c = Cursor { bytes, pos: 0 };
    let magic = c.take(4)?;
    if magic != b"TIL1" && magic != b"TIL2" {
        return Err("Invalid tile magic".into());
    }
    let with_heights = magic == b"TIL2";
    let count = c.u32()? as usize;
    if count > 500_000 {
        return Err("Tile feature limit exceeded".into());
    }
    let mut features = Vec::new();
    let mut points = 0;
    for _ in 0..count {
        let class = c.u8()? as usize;
        let kind = c.u8()?;
        if class > 7 || !(1..=3).contains(&kind) {
            return Err("Invalid tile feature type".into());
        }
        let parts = c.u16()?;
        let (height, min_height) = if with_heights && class == 2 {
            let height = c.f32()?;
            let min = c.f32()?;
            let source = c.u8()?;
            if !height.is_finite()
                || !min.is_finite()
                || !(height == -1. || height > 0. && height <= 2000.)
                || !(0. ..=2000.).contains(&min)
                || height >= 0. && min >= height
                || source > 10
                || source & 3 > 2
                || (source & 3 == 0) != (height == -1.)
            {
                return Err("Invalid building height".into());
            }
            (height, min)
        } else {
            (-1., 0.)
        };
        let mut rings = Vec::new();
        for _ in 0..parts {
            let count = c.u32()? as usize;
            points += count;
            if points > 3_000_000 {
                return Err("Tile vertex limit exceeded".into());
            }
            let mut ring = Vec::new();
            for _ in 0..count {
                ring.push([c.u16()? as f32 / 65535.0, c.u16()? as f32 / 65535.0]);
            }
            rings.push(ring);
        }
        features.push(Feature {
            class,
            kind,
            rings,
            height,
            min_height,
        });
    }
    if c.pos != bytes.len() {
        return Err("Trailing tile data".into());
    }
    Ok(features)
}
fn vertex(out: &mut Vec<f32>, p: [f32; 2], offset: [f32; 2], height: f32) {
    out.extend_from_slice(&[p[0], p[1], offset[0], offset[1], height, 0., 0.]);
}
fn polygon(out: &mut Vec<f32>, rings: &[Vec<[f32; 2]>], height: f32) -> Result<(), String> {
    let mut points = Vec::<f64>::new();
    let mut holes = Vec::new();
    for (i, ring) in rings.iter().enumerate() {
        if i > 0 {
            holes.push(points.len() / 2);
        }
        for p in ring {
            points.extend_from_slice(&[p[0] as f64, p[1] as f64]);
        }
    }
    if points.len() < 6 {
        return Ok(());
    }
    for i in
        earcutr::earcut(&points, &holes, 2).map_err(|e| format!("Polygon tessellation: {e:?}"))?
    {
        vertex(
            out,
            [points[i * 2] as f32, points[i * 2 + 1] as f32],
            [0., 0.],
            height,
        );
    }
    Ok(())
}
fn area(ring: &[[f32; 2]]) -> f64 {
    ring.windows(2)
        .map(|p| p[0][0] as f64 * p[1][1] as f64 - p[1][0] as f64 * p[0][1] as f64)
        .sum()
}
fn walls(out: &mut Vec<f32>, rings: &[Vec<[f32; 2]>], base: f32, top: f32) {
    let sign = rings.first().map(|r| area(r).signum() as f32).unwrap_or(1.);
    for ring in rings {
        for segment in ring.windows(2) {
            let a = segment[0];
            let b = segment[1];
            let dx = b[0] - a[0];
            let dy = b[1] - a[1];
            let length = dx.hypot(dy);
            if length < 1e-10 {
                continue;
            }
            let normal = [dy / length * sign, -dx / length * sign];
            for (p, z) in [
                (a, base),
                (b, base),
                (a, top),
                (a, top),
                (b, base),
                (b, top),
            ] {
                out.extend_from_slice(&[p[0], p[1], 0., 0., z, normal[0], normal[1]]);
            }
        }
    }
}
fn roof_height(f: &Feature) -> f32 {
    if f.class != 2 {
        0.
    } else if f.height < 0. {
        -f.min_height - 1.
    } else {
        f.height
    }
}
fn base_line_width(class: usize) -> f32 {
    match class {
        1 => 1.3,
        3 => 1.5,
        4 => 2.8,
        5 => 0.65,
        _ => 1.0,
    }
}
/// Cartographic widths in CSS pixels, continuously interpolated across fractional zooms.
/// These are visual defaults, not surveyed OSM feature widths.
fn line_width(class: usize, zoom: f64) -> f32 {
    let stops: &[(f64, f32)] = match class {
        1 => &[
            (9., 1.),
            (12., 1.6),
            (14., 2.2),
            (16., 3.5),
            (18., 6.),
            (20., 9.),
        ],
        3 => &[
            (10., 0.7),
            (12., 1.4),
            (14., 3.),
            (16., 6.),
            (18., 12.),
            (20., 20.),
        ],
        4 => &[
            (0., 0.8),
            (8., 1.1),
            (10., 1.5),
            (12., 2.6),
            (14., 5.),
            (16., 10.),
            (18., 18.),
            (20., 28.),
        ],
        5 => &[(12., 0.7), (14., 1.2), (16., 2.2), (18., 4.), (20., 7.)],
        6 => &[
            (9., 0.6),
            (12., 1.),
            (14., 1.8),
            (16., 3.5),
            (18., 6.),
            (20., 9.),
        ],
        _ => return base_line_width(class),
    };
    for pair in stops.windows(2) {
        if zoom <= pair[1].0 {
            let t = ((zoom - pair[0].0) / (pair[1].0 - pair[0].0)).clamp(0., 1.) as f32;
            return pair[0].1 + (pair[1].1 - pair[0].1) * t;
        }
    }
    stops.last().unwrap().1
}
fn line(out: &mut Vec<f32>, points: &[[f32; 2]], width: f32, joined: bool) {
    let mut path: Vec<[f32; 2]> = Vec::new();
    for p in points {
        if path
            .last()
            .map(|a| (a[0] - p[0]).hypot(a[1] - p[1]) >= 1e-10)
            .unwrap_or(true)
        {
            path.push(*p);
        }
    }
    if path.len() < 2 {
        return;
    }
    let closed = path.first() == path.last();
    let normals: Vec<[f32; 2]> = path
        .windows(2)
        .map(|p| {
            let dx = p[1][0] - p[0][0];
            let dy = p[1][1] - p[0][1];
            let len = dx.hypot(dy);
            [-dy / len * width / 2., dx / len * width / 2.]
        })
        .collect();
    for (i, segment) in path.windows(2).enumerate() {
        let (a, b) = (segment[0], segment[1]);
        let n = normals[i];
        // Square caps connect independently stored line fragments without tiny endpoint gaps.
        let start = if joined && !closed && i == 0 {
            [-n[1], n[0]]
        } else {
            [0., 0.]
        };
        let end = if joined && !closed && i == normals.len() - 1 {
            [n[1], -n[0]]
        } else {
            [0., 0.]
        };
        let an = [n[0] + start[0], n[1] + start[1]];
        let am = [-n[0] + start[0], -n[1] + start[1]];
        let bn = [n[0] + end[0], n[1] + end[1]];
        let bm = [-n[0] + end[0], -n[1] + end[1]];
        for (p, o) in [(a, an), (a, am), (b, bn), (b, bn), (a, am), (b, bm)] {
            vertex(out, p, o, 0.);
        }
    }
    if joined {
        // Fill the outside wedge at bends; bevels stay bounded at acute turns.
        let end = if closed { path.len() } else { path.len() - 1 };
        for i in 1..end {
            let prev = normals[i - 1];
            let next = normals[i % normals.len()];
            let cross = prev[0] * next[1] - prev[1] * next[0];
            if cross.abs() < 1e-10 {
                continue;
            }
            let sign = -cross.signum();
            vertex(out, path[i], [0., 0.], 0.);
            vertex(out, path[i], [prev[0] * sign, prev[1] * sign], 0.);
            vertex(out, path[i], [next[0] * sign, next[1] * sign], 0.);
        }
    }
}
fn mesh(features: &[Feature]) -> Result<(Vec<Vec<f32>>, usize), String> {
    let mut layers = vec![Vec::new(); 8];
    for f in features {
        let out = &mut layers[f.class];
        if f.kind == 3 {
            let mut group = Vec::new();
            let mut outer_sign = 0.;
            for ring in &f.rings {
                if ring.len() < 4 {
                    continue;
                }
                let sign = area(ring).signum();
                if group.is_empty() {
                    outer_sign = sign;
                } else if sign == outer_sign {
                    polygon(out, &group, roof_height(f))?;
                    group.clear();
                }
                group.push(ring.clone());
            }
            polygon(out, &group, roof_height(f))?;
        } else if f.kind == 2 {
            for ring in &f.rings {
                line(
                    out,
                    ring,
                    base_line_width(f.class),
                    matches!(f.class, 1 | 3..=6),
                );
            }
        } else {
            for ring in &f.rings {
                for p in ring {
                    for o in [[0., -4.], [-3.5, 3.], [3.5, 3.]] {
                        vertex(out, *p, o, 0.);
                    }
                }
            }
        }
    }
    let roof_vertices = layers[2].len() / 7;
    for f in features.iter().filter(|f| f.class == 2 && f.kind == 3) {
        walls(&mut layers[2], &f.rings, f.min_height, roof_height(f));
    }
    Ok((layers, roof_vertices))
}
/// Roof/footprint outlines, including courtyard rims, with a one-pixel unit width.
/// Boundaries introduced by tile clipping are omitted to avoid drawing the tile grid.
fn building_edges(features: &[Feature]) -> Vec<f32> {
    let mut out = Vec::new();
    for f in features.iter().filter(|f| f.class == 2 && f.kind == 3) {
        for ring in &f.rings {
            for segment in ring.windows(2) {
                let (a, b) = (segment[0], segment[1]);
                if (a[0] == b[0] && (a[0] == 0. || a[0] == 1.))
                    || (a[1] == b[1] && (a[1] == 0. || a[1] == 1.))
                {
                    continue;
                }
                let dx = b[0] - a[0];
                let dy = b[1] - a[1];
                let length = dx.hypot(dy);
                if length < 1e-10 {
                    continue;
                }
                let n = [-dy / length / 2., dx / length / 2.];
                let m = [-n[0], -n[1]];
                for (p, o) in [(a, n), (a, m), (b, n), (b, n), (a, m), (b, m)] {
                    vertex(&mut out, p, o, roof_height(f));
                }
            }
        }
    }
    out
}
fn clip_vertices(
    coordinates: &[f64],
    rings: &[u32],
    polygons: &[u32],
) -> Result<([f64; 2], Vec<f32>), String> {
    if coordinates.len() > 200_000
        || coordinates.len() % 2 != 0
        || coordinates.iter().any(|n| !n.is_finite())
        || rings.iter().any(|n| *n < 3)
        || polygons.contains(&0)
        || rings.iter().map(|n| *n as usize).sum::<usize>() * 2 != coordinates.len()
        || polygons.iter().map(|n| *n as usize).sum::<usize>() != rings.len()
    {
        return Err("Invalid coverage polygon".into());
    }
    let origin = [
        *coordinates.first().unwrap_or(&0.),
        *coordinates.get(1).unwrap_or(&0.),
    ];
    let mut output = Vec::new();
    let (mut ring_offset, mut point_offset) = (0, 0);
    for count in polygons {
        let sizes = &rings[ring_offset..ring_offset + *count as usize];
        let points = sizes.iter().map(|n| *n as usize).sum::<usize>();
        let data = &coordinates[point_offset * 2..(point_offset + points) * 2];
        let mut holes = Vec::new();
        let mut offset = sizes[0] as usize;
        for size in &sizes[1..] {
            holes.push(offset);
            offset += *size as usize;
        }
        let local: Vec<f64> = data
            .iter()
            .enumerate()
            .map(|(i, n)| n - origin[i % 2])
            .collect();
        for index in earcutr::earcut(&local, &holes, 2).map_err(|e| e.to_string())? {
            output.extend_from_slice(&[
                local[index * 2] as f32,
                local[index * 2 + 1] as f32,
                0.,
                0.,
                0.,
                0.,
                0.,
            ]);
        }
        ring_offset += *count as usize;
        point_offset += points;
    }
    Ok((origin, output))
}
struct Layer {
    buffer: Option<WebGlBuffer>,
    count: i32,
    flat_count: i32,
}
struct Tile {
    z: u32,
    x: u32,
    y: u32,
    layers: Vec<Layer>,
    clip: u32,
}
struct Clip {
    origin: [f64; 2],
    buffer: WebGlBuffer,
    count: i32,
}
#[wasm_bindgen]
pub struct Renderer {
    gl: Gl,
    program: WebGlProgram,
    origin: WebGlUniformLocation,
    scale: WebGlUniformLocation,
    view: WebGlUniformLocation,
    paint: WebGlUniformLocation,
    stroke: WebGlUniformLocation,
    rotation: WebGlUniformLocation,
    scene: WebGlUniformLocation,
    depth: WebGlUniformLocation,
    fallback: WebGlUniformLocation,
    colors: [[f32; 3]; 8],
    background: [f32; 3],
    widths: [f32; 8],
    tiles: BTreeMap<String, Tile>,
    visible: Vec<String>,
    mask: u32,
    clips: BTreeMap<u32, Clip>,
    active_clip: Cell<u32>,
}
#[wasm_bindgen]
impl Renderer {
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: HtmlCanvasElement) -> Result<Renderer, JsValue> {
        let options = js_sys::Object::new();
        js_sys::Reflect::set(&options, &"stencil".into(), &JsValue::TRUE)?;
        let gl: Gl = canvas
            .get_context_with_context_options("webgl2", &options)?
            .ok_or_else(|| JsValue::from_str("WebGL2 is required"))?
            .dyn_into()?;
        let vs = compile(
            &gl,
            Gl::VERTEX_SHADER,
            r#"#version 300 es
            precision highp float;
            layout(location=0) in vec2 a_position;
            layout(location=1) in vec2 a_offset;
            // Height in meters (negative = unknown roof above base) + face normal; paint is never baked into vertices.
            layout(location=2) in vec3 a_surface;
            uniform vec2 u_origin; uniform float u_scale; uniform vec2 u_view;
            uniform vec3 u_paint; uniform float u_stroke; uniform vec2 u_rotation;
            // sin(pitch), cos(pitch), pixels per height-meter, shading strength
            uniform vec4 u_scene; uniform float u_depth; uniform float u_fallback;
            out vec3 color;
            void main() {
              vec2 p = u_origin + a_position * u_scale + a_offset * u_stroke;
              vec2 q = vec2(u_rotation.y * p.x + u_rotation.x * p.y,
                           -u_rotation.x * p.x + u_rotation.y * p.y);
              float z = (a_surface.x < 0.0 ? -a_surface.x - 1.0 + u_fallback : a_surface.x) * u_scene.z;
              float y = q.y * u_scene.y - z * u_scene.x;
              float depth = -(q.y * u_scene.x + z * u_scene.y) / u_depth;
              gl_Position = vec4(q.x / u_view.x * 2.0, -y / u_view.y * 2.0, depth, 1.0);
              float light = length(a_surface.yz) > 0.5 ? 0.68 + 0.24 * dot(a_surface.yz, normalize(vec2(-0.6, -0.8))) : 1.0;
              color = u_paint * mix(1.0, light, u_scene.w);
            }
        "#,
        )?;
        let fs = compile(
            &gl,
            Gl::FRAGMENT_SHADER,
            r#"#version 300 es
            precision mediump float; in vec3 color; out vec4 out_color;
            void main() { out_color = vec4(color,1.0); }
        "#,
        )?;
        let program = gl
            .create_program()
            .ok_or_else(|| JsValue::from_str("Cannot create program"))?;
        gl.attach_shader(&program, &vs);
        gl.attach_shader(&program, &fs);
        gl.link_program(&program);
        gl.delete_shader(Some(&vs));
        gl.delete_shader(Some(&fs));
        if !gl
            .get_program_parameter(&program, Gl::LINK_STATUS)
            .as_bool()
            .unwrap_or(false)
        {
            return Err(JsValue::from_str(
                &gl.get_program_info_log(&program).unwrap_or_default(),
            ));
        }
        let uniform = |name| {
            gl.get_uniform_location(&program, name)
                .ok_or_else(|| JsValue::from_str("Missing shader uniform"))
        };
        let origin = uniform("u_origin")?;
        let scale = uniform("u_scale")?;
        let view = uniform("u_view")?;
        let paint = uniform("u_paint")?;
        let stroke = uniform("u_stroke")?;
        let rotation = uniform("u_rotation")?;
        let scene = uniform("u_scene")?;
        let depth = uniform("u_depth")?;
        let fallback = uniform("u_fallback")?;
        gl.use_program(Some(&program));
        gl.disable(Gl::DEPTH_TEST);
        Ok(Renderer {
            gl,
            program,
            origin,
            scale,
            view,
            paint,
            stroke,
            rotation,
            scene,
            depth,
            fallback,
            colors: COLORS,
            background: [0.91, 0.90, 0.84],
            widths: [1.; 8],
            tiles: BTreeMap::new(),
            visible: Vec::new(),
            mask: 255,
            clips: BTreeMap::new(),
            active_clip: Cell::new(u32::MAX),
        })
    }
    pub fn add_tile(&mut self, z: u32, x: u32, y: u32, bytes: &[u8]) -> Result<u32, JsValue> {
        self.add_tile_part(&format!("tile/{z}/{x}/{y}"), z, x, y, bytes)
    }
    pub fn add_tile_part(
        &mut self,
        key: &str,
        z: u32,
        x: u32,
        y: u32,
        bytes: &[u8],
    ) -> Result<u32, JsValue> {
        if z > 18 || x >= (1 << z) || y >= (1 << z) {
            return Err(JsValue::from_str("Invalid tile address"));
        }
        let features = decode(bytes).map_err(|e| JsValue::from_str(&e))?;
        let (mut meshes, roof_vertices) = mesh(&features).map_err(|e| JsValue::from_str(&e))?;
        // Internal layer 8 is an independently styled roof-edge buffer.
        meshes.push(building_edges(&features));
        let mut layers = Vec::new();
        for (class, data) in meshes.into_iter().enumerate() {
            if data.is_empty() {
                layers.push(Layer {
                    buffer: None,
                    count: 0,
                    flat_count: 0,
                });
                continue;
            }
            let buffer = self
                .gl
                .create_buffer()
                .ok_or_else(|| JsValue::from_str("Cannot allocate GPU buffer"))?;
            self.gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&buffer));
            let array = js_sys::Float32Array::from(data.as_slice());
            self.gl
                .buffer_data_with_array_buffer_view(Gl::ARRAY_BUFFER, &array, Gl::STATIC_DRAW);
            layers.push(Layer {
                buffer: Some(buffer),
                count: (data.len() / 7) as i32,
                flat_count: if class == 2 {
                    roof_vertices
                } else {
                    data.len() / 7
                } as i32,
            });
        }
        if let Some(old) = self.tiles.remove(key) {
            for layer in old.layers {
                self.gl.delete_buffer(layer.buffer.as_ref());
            }
        }
        self.tiles.insert(
            key.to_owned(),
            Tile {
                z,
                x,
                y,
                layers,
                clip: 0,
            },
        );
        Ok(features.len() as u32)
    }
    /// Exact vertex-buffer bytes retained on the GPU (driver overhead excluded).
    pub fn tile_bytes(&self, key: &str) -> u32 {
        self.tiles
            .get(key)
            .map(|t| t.layers.iter().map(|l| l.count as u32 * 7 * 4).sum())
            .unwrap_or(0)
    }
    pub fn remove_tile(&mut self, key: &str) {
        if let Some(tile) = self.tiles.remove(key) {
            for layer in tile.layers {
                self.gl.delete_buffer(layer.buffer.as_ref());
            }
        }
    }
    pub fn set_visible(&mut self, keys: &str) {
        self.visible = keys
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
    }
    /// A composition owns coverage per source/layer. Coordinates are normalized
    /// Mercator; subtract the origin in f64 before uploading to preserve detail.
    pub fn set_clip(
        &mut self,
        id: u32,
        coordinates: &[f64],
        rings: &[u32],
        polygons: &[u32],
    ) -> Result<(), JsValue> {
        if id == 0 {
            return Err(JsValue::from_str("Clip zero is reserved"));
        }
        let (origin, vertices) =
            clip_vertices(coordinates, rings, polygons).map_err(|e| JsValue::from_str(&e))?;
        let buffer = self
            .gl
            .create_buffer()
            .ok_or_else(|| JsValue::from_str("Cannot allocate clip"))?;
        self.gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&buffer));
        let array = js_sys::Float32Array::from(vertices.as_slice());
        self.gl
            .buffer_data_with_array_buffer_view(Gl::ARRAY_BUFFER, &array, Gl::STATIC_DRAW);
        if let Some(old) = self.clips.insert(
            id,
            Clip {
                origin,
                buffer,
                count: (vertices.len() / 7) as i32,
            },
        ) {
            self.gl.delete_buffer(Some(&old.buffer));
        }
        Ok(())
    }
    pub fn set_tile_clip(&mut self, key: &str, clip: u32) {
        if let Some(tile) = self.tiles.get_mut(key) {
            tile.clip = clip;
        }
    }
    pub fn clear_clips(&mut self) {
        for clip in self.clips.values() {
            self.gl.delete_buffer(Some(&clip.buffer));
        }
        self.clips.clear();
    }
    pub fn set_layers(&mut self, mask: u32) {
        self.mask = mask;
    }
    pub fn set_style(
        &mut self,
        background: &[f32],
        colors: &[f32],
        widths: &[f32],
    ) -> Result<(), JsValue> {
        if background.len() != 3
            || colors.len() != 24
            || widths.len() != 8
            || background
                .iter()
                .chain(colors)
                .any(|v| !v.is_finite() || !(0. ..=1.).contains(v))
            || widths.iter().enumerate().any(|(i, v)| {
                !v.is_finite()
                    || if i == 2 {
                        !(0. ..=2.).contains(v)
                    } else if i == 3 || i == 4 {
                        // Road style 1x compiles to the slimmer 0.5 GPU multiplier.
                        !(0.125..=2.).contains(v)
                    } else {
                        !(0.25..=4.).contains(v)
                    }
            })
        {
            return Err(JsValue::from_str("Invalid style uniforms"));
        }
        self.background.copy_from_slice(background);
        for (target, color) in self.colors.iter_mut().zip(colors.chunks_exact(3)) {
            target.copy_from_slice(color);
        }
        self.widths.copy_from_slice(widths);
        Ok(())
    }
    pub fn clear(&mut self) {
        for tile in self.tiles.values() {
            for layer in &tile.layers {
                self.gl.delete_buffer(layer.buffer.as_ref());
            }
        }
        self.tiles.clear();
        self.visible.clear();
    }
    pub fn render(
        &self,
        cx: f64,
        cy: f64,
        zoom: f64,
        width: f64,
        height: f64,
        pixel_ratio: f64,
        pitch: f64,
        bearing: f64,
        height_scale: f64,
        fallback_height: f64,
        shading: f64,
    ) -> u32 {
        self.active_clip.set(u32::MAX);
        self.gl.disable(Gl::STENCIL_TEST);
        self.gl.viewport(
            0,
            0,
            (width * pixel_ratio) as i32,
            (height * pixel_ratio) as i32,
        );
        self.gl.clear_color(
            self.background[0],
            self.background[1],
            self.background[2],
            1.0,
        );
        self.gl.depth_mask(true);
        self.gl.clear(Gl::COLOR_BUFFER_BIT | Gl::DEPTH_BUFFER_BIT);
        self.gl.disable(Gl::DEPTH_TEST);
        self.gl.use_program(Some(&self.program));
        self.gl
            .uniform2f(Some(&self.view), width as f32, height as f32);
        let world = 256.0 * 2.0_f64.powf(zoom);
        let pitch = pitch.clamp(0., 65.).to_radians();
        let bearing = bearing.to_radians();
        let latitude = (std::f64::consts::PI * (1. - 2. * cy)).sinh().atan();
        let height_px =
            (height_scale.clamp(0., 3.) * world / (40075016.686 * latitude.cos())) as f32;
        self.gl
            .uniform1f(Some(&self.fallback), fallback_height.clamp(1., 100.) as f32);
        let extruded = height_px > 0.;
        self.gl.uniform2f(
            Some(&self.rotation),
            bearing.sin() as f32,
            bearing.cos() as f32,
        );
        self.gl.uniform4f(
            Some(&self.scene),
            pitch.sin() as f32,
            pitch.cos() as f32,
            height_px,
            if extruded {
                shading.clamp(0., 1.) as f32
            } else {
                0.
            },
        );
        self.gl.uniform1f(
            Some(&self.depth),
            width.max(height) as f32 * 8. + height_px * 2100. * 4.,
        );
        let order = if extruded {
            [0, 1, 5, 6, 3, 4, 7, 2]
        } else {
            [0, 1, 2, 5, 6, 3, 4, 7]
        };
        let mut triangles = 0;
        for layer_id in order {
            if layer_id == 3 {
                for class in [3, 4] {
                    if self.mask & (1 << class) == 0 {
                        continue;
                    }
                    let border = ((zoom - 11.) / 5.).clamp(0., 1.) as f32 * 0.65;
                    if border == 0. {
                        continue;
                    }
                    let color = self.colors[class];
                    self.gl.uniform3f(
                        Some(&self.paint),
                        color[0] * 0.8,
                        color[1] * 0.8,
                        color[2] * 0.8,
                    );
                    self.gl.uniform1f(
                        Some(&self.stroke),
                        (line_width(class, zoom) + 2. * border) * self.widths[class]
                            / base_line_width(class),
                    );
                    for key in &self.visible {
                        if let Some(tile) = self.tiles.get(key) {
                            triangles +=
                                self.draw_layer(tile, &tile.layers[class], cx, cy, world, extruded);
                        }
                    }
                }
            }
            if self.mask & (1 << layer_id) == 0 {
                continue;
            }
            if layer_id == 5 {
                // A narrow casing separates footways/trails from similarly colored land.
                let border = ((zoom - 13.) / 3.).clamp(0., 1.) as f32 * 0.4;
                if border > 0. {
                    let color = self.colors[5];
                    self.gl.uniform3f(
                        Some(&self.paint),
                        color[0] * 0.8,
                        color[1] * 0.8,
                        color[2] * 0.8,
                    );
                    self.gl.uniform1f(
                        Some(&self.stroke),
                        (line_width(5, zoom) + 2. * border) * self.widths[5] / base_line_width(5),
                    );
                    for key in &self.visible {
                        if let Some(tile) = self.tiles.get(key) {
                            triangles +=
                                self.draw_layer(tile, &tile.layers[5], cx, cy, world, extruded);
                        }
                    }
                }
            }
            if layer_id == 2 && extruded {
                self.gl.enable(Gl::DEPTH_TEST);
                self.gl.depth_func(Gl::LEQUAL);
                // Push filled faces slightly back so coplanar roof edges remain stable.
                self.gl.enable(Gl::POLYGON_OFFSET_FILL);
                self.gl.polygon_offset(1., 1.);
            }
            let color = self.colors[layer_id];
            self.gl
                .uniform3f(Some(&self.paint), color[0], color[1], color[2]);
            let stroke = if matches!(layer_id, 1 | 3..=6) {
                self.widths[layer_id] * line_width(layer_id, zoom) / base_line_width(layer_id)
            } else {
                self.widths[layer_id]
            };
            self.gl.uniform1f(Some(&self.stroke), stroke);
            for key in &self.visible {
                let Some(tile) = self.tiles.get(key) else {
                    continue;
                };
                triangles += self.draw_layer(tile, &tile.layers[layer_id], cx, cy, world, extruded);
            }
            if layer_id == 6 {
                // Railways are stored as centerlines. A lighter inset leaves two dark rails.
                // Fade it in at street zooms; reuse the joined line mesh and width multiplier.
                let inset = ((zoom - 13.) / 3.).clamp(0., 1.) as f32;
                if inset > 0. {
                    let color = self.colors[6].map(|c| c + (1. - c) * 0.7 * inset);
                    self.gl
                        .uniform3f(Some(&self.paint), color[0], color[1], color[2]);
                    self.gl.uniform1f(Some(&self.stroke), stroke * 0.45);
                    for key in &self.visible {
                        if let Some(tile) = self.tiles.get(key) {
                            triangles +=
                                self.draw_layer(tile, &tile.layers[6], cx, cy, world, extruded);
                        }
                    }
                }
            }
            if layer_id == 2 {
                self.gl.disable(Gl::POLYGON_OFFSET_FILL);
                // Draw after all building fills, so hidden roof edges stay occluded in 3D.
                let contrast = ((zoom - 13.) / 2.).clamp(0., 1.) as f32 * 0.24;
                if self.widths[2] > 0. && contrast > 0. {
                    self.gl.uniform3f(
                        Some(&self.paint),
                        color[0] * (1. - contrast),
                        color[1] * (1. - contrast),
                        color[2] * (1. - contrast),
                    );
                    self.gl.depth_mask(false);
                    for key in &self.visible {
                        if let Some(tile) = self.tiles.get(key) {
                            triangles +=
                                self.draw_layer(tile, &tile.layers[8], cx, cy, world, true);
                        }
                    }
                    self.gl.depth_mask(true);
                }
            }
        }
        self.gl.disable(Gl::DEPTH_TEST);
        triangles
    }
}
impl Renderer {
    fn activate_clip(&self, id: u32, cx: f64, cy: f64, world: f64) {
        if self.active_clip.get() == id {
            return;
        }
        self.active_clip.set(id);
        if id == 0 {
            self.gl.disable(Gl::STENCIL_TEST);
            return;
        }
        // Missing/empty coverage is intentionally invisible, never unbounded.
        self.gl.enable(Gl::STENCIL_TEST);
        self.gl.stencil_mask(255);
        self.gl.clear_stencil(0);
        self.gl.clear(Gl::STENCIL_BUFFER_BIT);
        self.gl.stencil_func(Gl::ALWAYS, 1, 255);
        self.gl.stencil_op(Gl::KEEP, Gl::KEEP, Gl::REPLACE);
        let depth = self.gl.is_enabled(Gl::DEPTH_TEST);
        self.gl.disable(Gl::DEPTH_TEST);
        self.gl.color_mask(false, false, false, false);
        if let Some(clip) = self.clips.get(&id) {
            self.gl.uniform2f(
                Some(&self.origin),
                ((clip.origin[0] - cx) * world) as f32,
                ((clip.origin[1] - cy) * world) as f32,
            );
            self.gl.uniform1f(Some(&self.scale), world as f32);
            self.gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&clip.buffer));
            for (slot, size, offset) in [(0, 2, 0), (1, 2, 8), (2, 3, 16)] {
                self.gl.enable_vertex_attrib_array(slot);
                self.gl
                    .vertex_attrib_pointer_with_i32(slot, size, Gl::FLOAT, false, 28, offset);
            }
            self.gl.draw_arrays(Gl::TRIANGLES, 0, clip.count);
        }
        self.gl.color_mask(true, true, true, true);
        if depth {
            self.gl.enable(Gl::DEPTH_TEST);
        }
        self.gl.stencil_mask(0);
        self.gl.stencil_func(Gl::EQUAL, 1, 255);
        self.gl.stencil_op(Gl::KEEP, Gl::KEEP, Gl::KEEP);
    }
    fn draw_layer(
        &self,
        tile: &Tile,
        layer: &Layer,
        cx: f64,
        cy: f64,
        world: f64,
        extruded: bool,
    ) -> u32 {
        let count = if extruded {
            layer.count
        } else {
            layer.flat_count
        };
        if count == 0 {
            return 0;
        }
        self.activate_clip(tile.clip, cx, cy, world);
        let n = 2.0_f64.powi(tile.z as i32);
        self.gl.uniform2f(
            Some(&self.origin),
            ((tile.x as f64 / n - cx) * world) as f32,
            ((tile.y as f64 / n - cy) * world) as f32,
        );
        self.gl.uniform1f(Some(&self.scale), (world / n) as f32);
        self.gl.bind_buffer(Gl::ARRAY_BUFFER, layer.buffer.as_ref());
        for (slot, size, offset) in [(0, 2, 0), (1, 2, 8), (2, 3, 16)] {
            self.gl.enable_vertex_attrib_array(slot);
            self.gl
                .vertex_attrib_pointer_with_i32(slot, size, Gl::FLOAT, false, 28, offset);
        }
        self.gl.draw_arrays(Gl::TRIANGLES, 0, count);
        count as u32 / 3
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        self.clear();
        self.clear_clips();
        self.gl.delete_program(Some(&self.program));
    }
}

fn compile(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, JsValue> {
    let shader = gl
        .create_shader(kind)
        .ok_or_else(|| JsValue::from_str("Cannot create shader"))?;
    gl.shader_source(&shader, source);
    gl.compile_shader(&shader);
    if gl
        .get_shader_parameter(&shader, Gl::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false)
    {
        Ok(shader)
    } else {
        Err(JsValue::from_str(
            &gl.get_shader_info_log(&shader).unwrap_or_default(),
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composition_clip_preserves_holes_and_local_precision() {
        let coordinates = [
            0.5, 0.5, 0.51, 0.5, 0.51, 0.51, 0.5, 0.51, 0.502, 0.502, 0.508, 0.502, 0.508, 0.508,
            0.502, 0.508, 0.7, 0.7, 0.702, 0.7, 0.702, 0.702, 0.7, 0.702,
        ];
        let (origin, vertices) = clip_vertices(&coordinates, &[4, 4, 4], &[2, 1]).unwrap();
        assert_eq!(origin, [0.5, 0.5]);
        let area: f32 = vertices
            .chunks_exact(21)
            .map(|t| ((t[7] - t[0]) * (t[15] - t[1]) - (t[14] - t[0]) * (t[8] - t[1])).abs() / 2.)
            .sum();
        assert!((area - (0.01 * 0.01 - 0.006 * 0.006 + 0.002 * 0.002)).abs() < 1e-9);
        assert!(clip_vertices(&coordinates, &[4, 4, 4], &[1]).is_err());
        assert!(clip_vertices(&[f64::NAN, 0.], &[1], &[1]).is_err());
        let tiny = [0.5, 0.5, 0.500000001, 0.5, 0.5, 0.500000001];
        let (_, vertices) = clip_vertices(&tiny, &[3], &[1]).unwrap();
        assert_eq!(vertices.len(), 21);
        assert!(vertices.iter().any(|n| *n > 0. && *n < 0.00000001));
    }
    #[test]
    fn linear_feature_bends_are_filled_and_duplicate_points_are_safe() {
        for class in [1, 3, 4, 5, 6] {
            let feature = Feature {
                class,
                kind: 2,
                height: -1.,
                min_height: 0.,
                rings: vec![vec![[0., 0.], [1., 0.], [1., 0.], [1., 1.]]],
            };
            let (meshes, _) = mesh(&[feature]).unwrap();
            let vertices = &meshes[class];
            assert!(vertices.iter().all(|n| n.is_finite()));
            let point = [1.05, -0.05];
            let covers = vertices.chunks_exact(21).any(|t| {
                let p: Vec<_> = t
                    .chunks_exact(7)
                    .map(|v| {
                        [
                            v[0] + v[2] * 0.4 / base_line_width(class),
                            v[1] + v[3] * 0.4 / base_line_width(class),
                        ]
                    })
                    .collect();
                let signs: Vec<_> = (0..3)
                    .map(|i| {
                        let a = p[i];
                        let b = p[(i + 1) % 3];
                        (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
                    })
                    .collect();
                signs.iter().all(|x| *x >= 0.) || signs.iter().all(|x| *x <= 0.)
            });
            assert!(
                covers,
                "Class {class} must not leave a gap at the outer corner"
            );
        }
        let mut zero = Vec::new();
        line(&mut zero, &[[0., 0.], [0., 0.]], 1., true);
        assert!(zero.is_empty());
    }
    #[test]
    fn water_area_vertices_are_unaffected_by_stroke_width() {
        let feature = Feature {
            class: 1,
            kind: 3,
            height: -1.,
            min_height: 0.,
            rings: vec![vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.], [0., 0.]]],
        };
        let (meshes, _) = mesh(&[feature]).unwrap();
        assert!(!meshes[1].is_empty());
        assert!(meshes[1].chunks_exact(7).all(|v| v[2] == 0. && v[3] == 0.));
    }
    #[test]
    fn road_widths_are_continuous_and_preserve_class_hierarchy() {
        for z in [12., 14., 15., 16., 18., 20.] {
            assert!(line_width(4, z) > line_width(3, z));
            assert!(line_width(3, z) > line_width(5, z));
            assert!((line_width(3, z - 0.0001) - line_width(3, z + 0.0001)).abs() < 0.001);
        }
        assert_eq!(line_width(3, 16.), 6.);
        assert_eq!(line_width(4, 16.), 10.);
        assert_eq!(line_width(5, 16.), 2.2);
        for class in [1, 5, 6] {
            for z in [9., 12., 13., 14., 15., 16., 18., 20.] {
                assert!(
                    (line_width(class, z - 0.0001) - line_width(class, z + 0.0001)).abs() < 0.001
                );
            }
            assert!(line_width(class, 20.) > line_width(class, 16.));
            assert!(line_width(class, 16.) > line_width(class, 14.));
        }
    }
    #[test]
    fn building_edges_keep_courtyards_and_height_but_omit_tile_cuts() {
        let f = Feature {
            class: 2,
            kind: 3,
            height: 24.,
            min_height: 6.,
            rings: vec![
                vec![[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.1, 0.1]],
                vec![[0.3, 0.3], [0.3, 0.7], [0.7, 0.7], [0.7, 0.3], [0.3, 0.3]],
            ],
        };
        let edges = building_edges(&[f]);
        assert_eq!(edges.len() / 7, 8 * 6);
        assert!(edges
            .chunks_exact(7)
            .all(|v| v[4] == 24. && (v[2].hypot(v[3]) - 0.5).abs() < 1e-6));
        let cut = Feature {
            class: 2,
            kind: 3,
            height: -1.,
            min_height: 3.,
            rings: vec![vec![[0., 0.], [0.5, 0.], [0.5, 0.5], [0., 0.5], [0., 0.]]],
        };
        let edges = building_edges(&[cut]);
        assert_eq!(edges.len() / 7, 2 * 6);
        assert!(edges.chunks_exact(7).all(|v| v[4] == -4.));
        let water = Feature {
            class: 1,
            kind: 3,
            height: -1.,
            min_height: 0.,
            rings: vec![vec![[0., 0.], [0.5, 0.], [0.5, 0.5], [0., 0.]]],
        };
        assert!(building_edges(&[water]).is_empty());
    }
    #[test]
    fn heights_survive_decode_into_roofs_and_elevated_wall_bases() {
        let mut bytes = b"TIL2".to_vec();
        bytes.extend(1_u32.to_le_bytes());
        bytes.extend([2, 3, 1, 0]);
        bytes.extend(24_f32.to_le_bytes());
        bytes.extend(6_f32.to_le_bytes());
        bytes.push(5);
        bytes.extend(5_u32.to_le_bytes());
        for p in [[0_u16, 0], [65535, 0], [65535, 65535], [0, 65535], [0, 0]] {
            bytes.extend(p[0].to_le_bytes());
            bytes.extend(p[1].to_le_bytes());
        }
        let features = decode(&bytes).unwrap();
        let (layers, roofs) = mesh(&features).unwrap();
        assert!(layers[2][..roofs * 7].chunks_exact(7).all(|v| v[4] == 24.));
        assert!(layers[2][roofs * 7..]
            .chunks_exact(7)
            .all(|v| v[4] == 6. || v[4] == 24.));
        bytes[12..16].copy_from_slice(&(-1_f32).to_le_bytes());
        bytes[20] = 4;
        let unknown = decode(&bytes).unwrap();
        assert_eq!(roof_height(&unknown[0]), -7.); // Shader adds the fallback above this 6 m base.
        bytes[12..16].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(decode(&bytes).is_err());
        bytes[12..16].copy_from_slice(&24_f32.to_le_bytes());
        bytes[20] = 5;
        bytes[16..20].copy_from_slice(&25_f32.to_le_bytes());
        assert!(decode(&bytes).is_err());
    }
    #[test]
    fn rejects_truncated_and_unknown_tiles() {
        assert!(decode(b"TIL1").is_err());
        assert!(decode(b"MVT10000").is_err());
        assert!(decode(&[84, 73, 76, 49, 1, 0, 0, 0, 9, 1, 0, 0]).is_err());
    }
    #[test]
    fn decodes_and_meshes_a_line() {
        let bytes = [
            84, 73, 76, 49, 1, 0, 0, 0, 4, 2, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255,
        ];
        let features = decode(&bytes).unwrap();
        assert_eq!(mesh(&features).unwrap().0[4].len(), 6 * 7);
    }
    #[test]
    fn building_roofs_keep_courtyards_and_walls_close_both_boundaries() {
        let features = vec![Feature {
            class: 2,
            kind: 3,
            height: 1.,
            min_height: 0.,
            rings: vec![
                vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.], [0., 0.]],
                vec![
                    [0.25, 0.25],
                    [0.25, 0.75],
                    [0.75, 0.75],
                    [0.75, 0.25],
                    [0.25, 0.25],
                ],
            ],
        }];
        let (meshes, roofs) = mesh(&features).unwrap();
        let m = &meshes[2];
        let area: f32 = m[..roofs * 7]
            .chunks_exact(21)
            .map(|t| ((t[7] - t[0]) * (t[15] - t[1]) - (t[14] - t[0]) * (t[8] - t[1])).abs() / 2.)
            .sum();
        assert!((area - 0.75).abs() < 1e-6);
        assert_eq!(m.len() / 7 - roofs, 8 * 6);
        for v in m[..roofs * 7].chunks_exact(7) {
            assert_eq!(&v[4..], &[1., 0., 0.]);
        }
        for v in m[roofs * 7..].chunks_exact(7) {
            assert!(v[4] == 0. || v[4] == 1.);
            assert!((v[5].hypot(v[6]) - 1.).abs() < 1e-6);
        }
    }
    #[test]
    fn polygon_hole_does_not_get_filled() {
        let features = vec![Feature {
            class: 0,
            kind: 3,
            height: -1.,
            min_height: 0.,
            rings: vec![
                vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.], [0., 0.]],
                vec![
                    [0.25, 0.25],
                    [0.25, 0.75],
                    [0.75, 0.75],
                    [0.75, 0.25],
                    [0.25, 0.25],
                ],
            ],
        }];
        let (meshes, _) = mesh(&features).unwrap();
        let mut total = 0.;
        for t in meshes[0].chunks_exact(21) {
            total += ((t[7] - t[0]) * (t[15] - t[1]) - (t[14] - t[0]) * (t[8] - t[1])).abs() / 2.;
        }
        assert!((total - 0.75).abs() < 1e-6);
    }
}
