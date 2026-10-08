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
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}
fn decode(bytes: &[u8]) -> Result<Vec<Feature>, String> {
    let mut c = Cursor { bytes, pos: 0 };
    if c.take(4)? != b"TIL1" {
        return Err("Invalid tile magic".into());
    }
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
        features.push(Feature { class, kind, rings });
    }
    if c.pos != bytes.len() {
        return Err("Trailing tile data".into());
    }
    Ok(features)
}
fn vertex(out: &mut Vec<f32>, p: [f32; 2], offset: [f32; 2], class: usize) {
    out.extend_from_slice(&[
        p[0],
        p[1],
        offset[0],
        offset[1],
        COLORS[class][0],
        COLORS[class][1],
        COLORS[class][2],
    ]);
}
fn polygon(out: &mut Vec<f32>, rings: &[Vec<[f32; 2]>], class: usize) -> Result<(), String> {
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
            class,
        );
    }
    Ok(())
}
fn area(ring: &[[f32; 2]]) -> f64 {
    ring.windows(2)
        .map(|p| p[0][0] as f64 * p[1][1] as f64 - p[1][0] as f64 * p[0][1] as f64)
        .sum()
}
fn mesh(features: &[Feature]) -> Result<Vec<Vec<f32>>, String> {
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
                    polygon(out, &group, f.class)?;
                    group.clear();
                }
                group.push(ring.clone());
            }
            polygon(out, &group, f.class)?;
        } else if f.kind == 2 {
            let width = match f.class {
                1 => 1.3,
                3 => 1.5,
                4 => 2.8,
                5 => 0.65,
                6 => 1.0,
                _ => 1.0,
            };
            for ring in &f.rings {
                for segment in ring.windows(2) {
                    let a = segment[0];
                    let b = segment[1];
                    let dx = b[0] - a[0];
                    let dy = b[1] - a[1];
                    let length = (dx * dx + dy * dy).sqrt();
                    if length < 1e-10 {
                        continue;
                    }
                    let n = [-dy / length * width / 2., dx / length * width / 2.];
                    let m = [-n[0], -n[1]];
                    for (p, o) in [(a, n), (a, m), (b, n), (b, n), (a, m), (b, m)] {
                        vertex(out, p, o, f.class);
                    }
                }
            }
        } else {
            for ring in &f.rings {
                for p in ring {
                    for o in [[0., -4.], [-3.5, 3.], [3.5, 3.]] {
                        vertex(out, *p, o, f.class);
                    }
                }
            }
        }
    }
    Ok(layers)
}
struct Layer {
    buffer: Option<WebGlBuffer>,
    count: i32,
}
struct Tile {
    z: u32,
    x: u32,
    y: u32,
    layers: Vec<Layer>,
}
#[wasm_bindgen]
pub struct Renderer {
    gl: Gl,
    program: WebGlProgram,
    origin: WebGlUniformLocation,
    scale: WebGlUniformLocation,
    view: WebGlUniformLocation,
    tiles: BTreeMap<String, Tile>,
    visible: Vec<String>,
    mask: u32,
}
#[wasm_bindgen]
impl Renderer {
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: HtmlCanvasElement) -> Result<Renderer, JsValue> {
        let gl: Gl = canvas
            .get_context("webgl2")?
            .ok_or_else(|| JsValue::from_str("WebGL2 is required"))?
            .dyn_into()?;
        let vs = compile(
            &gl,
            Gl::VERTEX_SHADER,
            r#"#version 300 es
            precision highp float;
            layout(location=0) in vec2 a_position;
            layout(location=1) in vec2 a_offset;
            layout(location=2) in vec3 a_color;
            uniform vec2 u_origin; uniform float u_scale; uniform vec2 u_view;
            out vec3 color;
            void main() { vec2 p = u_origin + a_position * u_scale + a_offset;
              gl_Position = vec4(p.x / u_view.x * 2.0, -p.y / u_view.y * 2.0, 0.0, 1.0); color = a_color; }
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
        gl.use_program(Some(&program));
        gl.disable(Gl::DEPTH_TEST);
        Ok(Renderer {
            gl,
            program,
            origin,
            scale,
            view,
            tiles: BTreeMap::new(),
            visible: Vec::new(),
            mask: 255,
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
        let meshes = mesh(&features).map_err(|e| JsValue::from_str(&e))?;
        let mut layers = Vec::new();
        for data in meshes {
            if data.is_empty() {
                layers.push(Layer {
                    buffer: None,
                    count: 0,
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
            });
        }
        if let Some(old) = self.tiles.remove(key) {
            for layer in old.layers {
                self.gl.delete_buffer(layer.buffer.as_ref());
            }
        }
        self.tiles.insert(key.to_owned(), Tile { z, x, y, layers });
        Ok(features.len() as u32)
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
    pub fn set_layers(&mut self, mask: u32) {
        self.mask = mask;
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
    ) -> u32 {
        self.gl.viewport(
            0,
            0,
            (width * pixel_ratio) as i32,
            (height * pixel_ratio) as i32,
        );
        self.gl.clear_color(0.91, 0.90, 0.84, 1.0);
        self.gl.clear(Gl::COLOR_BUFFER_BIT);
        self.gl.use_program(Some(&self.program));
        self.gl
            .uniform2f(Some(&self.view), width as f32, height as f32);
        let world = 256.0 * 2.0_f64.powf(zoom);
        let mut triangles = 0;
        for layer_id in [0, 1, 2, 5, 6, 3, 4, 7] {
            if self.mask & (1 << layer_id) == 0 {
                continue;
            }
            for key in &self.visible {
                let Some(tile) = self.tiles.get(key) else {
                    continue;
                };
                let layer = &tile.layers[layer_id];
                if layer.count == 0 {
                    continue;
                }
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
                    self.gl.vertex_attrib_pointer_with_i32(
                        slot,
                        size,
                        Gl::FLOAT,
                        false,
                        28,
                        offset,
                    );
                }
                self.gl.draw_arrays(Gl::TRIANGLES, 0, layer.count);
                triangles += layer.count as u32 / 3;
            }
        }
        triangles
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        self.clear();
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
        assert_eq!(mesh(&features).unwrap()[4].len(), 6 * 7);
    }
    #[test]
    fn polygon_hole_does_not_get_filled() {
        let features = vec![Feature {
            class: 0,
            kind: 3,
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
        let meshes = mesh(&features).unwrap();
        let mut total = 0.;
        for t in meshes[0].chunks_exact(21) {
            total += ((t[7] - t[0]) * (t[15] - t[1]) - (t[14] - t[0]) * (t[8] - t[1])).abs() / 2.;
        }
        assert!((total - 0.75).abs() < 1e-6);
    }
}

/// The same native-tested routing core exposed through the map's WASM module.
#[wasm_bindgen]
pub struct WalkingRouter {
    graph: atlas_routing::Graph,
}
#[wasm_bindgen]
impl WalkingRouter {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WalkingRouter, JsValue> {
        Ok(Self {
            graph: atlas_routing::Graph::decode(bytes).map_err(|e| JsValue::from_str(&e))?,
        })
    }
    pub fn route(
        &self,
        start_lon: f64,
        start_lat: f64,
        end_lon: f64,
        end_lat: f64,
    ) -> Result<String, JsValue> {
        let result = self
            .graph
            .route([start_lon, start_lat], [end_lon, end_lat])
            .map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
