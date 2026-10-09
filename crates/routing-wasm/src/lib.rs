//! Operation-only WASM facade. The native routing core has no browser dependencies.
use wasm_bindgen::prelude::*;

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

#[wasm_bindgen]
pub struct CellWalkingRouter {
    inner: atlas_routing::cells::PagedRouter,
}
#[wasm_bindgen]
impl CellWalkingRouter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: atlas_routing::cells::PagedRouter::new(96 * 1024 * 1024, 250_000),
        }
    }
    /// Explicit bounded opt-in for longer client journeys. The default constructor
    /// keeps the smaller single-map budget.
    pub fn with_limits(cell_bytes: u32, search_states: u32) -> Result<CellWalkingRouter, JsValue> {
        if !(1024 * 1024..=256 * 1024 * 1024).contains(&cell_bytes)
            || !(1_000..=2_000_000).contains(&search_states)
        {
            return Err(JsValue::from_str("Invalid routing budget"));
        }
        Ok(Self {
            inner: atlas_routing::cells::PagedRouter::new(
                cell_bytes as usize,
                search_states as usize,
            ),
        })
    }
    pub fn set_profile(&mut self, profile: u32) -> Result<(), JsValue> {
        self.inner
            .set_profile(profile)
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn begin_isochrone(&mut self, lon: f64, lat: f64, bands: &[f64]) -> Result<(), JsValue> {
        self.inner
            .begin_isochrone([lon, lat], bands.to_vec())
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn begin(&mut self, ax: f64, ay: f64, bx: f64, by: f64) -> Result<(), JsValue> {
        self.inner
            .begin([ax, ay], [bx, by])
            .map_err(|e| JsValue::from_str(&e))
    }
    pub fn load(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner.load(bytes).map_err(|e| JsValue::from_str(&e))
    }
    pub fn empty(&mut self, x: u32, y: u32) {
        self.inner.empty(x, y);
    }
    pub fn step(&mut self) -> Result<String, JsValue> {
        let value = self.inner.step(2048).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&value).map_err(|e| JsValue::from_str(&e.to_string()))
    }
    pub fn used_keys(&self) -> String {
        self.inner.used_keys().join(",")
    }
    pub fn memory_bytes(&self) -> u32 {
        self.inner.memory() as u32
    }
    pub fn cell_count(&self) -> u32 {
        self.inner.cell_count() as u32
    }
}
