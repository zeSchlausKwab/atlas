//! Bounded raster contours around the reachable network. These polygons are a
//! visualization envelope, not a claim that every enclosed point is traversable.
use crate::Snap;
use serde::Serialize;
use std::collections::BTreeMap;
#[derive(Clone, Copy)]
pub struct Piece {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub start: f64,
    pub duration: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reachability {
    pub status: &'static str,
    pub start: Snap,
    pub visited: usize,
    pub contours: FeatureCollection,
    pub resolution_meters: f64,
    pub segments: usize,
}
#[derive(Serialize)]
pub struct FeatureCollection {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub features: Vec<Feature>,
}
#[derive(Serialize)]
pub struct Feature {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub properties: Properties,
    pub geometry: Geometry,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Properties {
    pub seconds: f64,
    pub minutes: f64,
    pub area_km2: f64,
    pub approximate: bool,
}
#[derive(Serialize)]
pub struct Geometry {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub coordinates: Vec<Vec<Vec<[f64; 2]>>>,
}
pub fn build(start: Snap, bands: &[f64], pieces: Vec<Piece>, visited: usize) -> Reachability {
    let origin = start.coordinates;
    let scale = [
        111_195.080_233_532_9 * origin[1].to_radians().cos(),
        111_195.080_233_532_9,
    ];
    let project = |p: [f64; 2]| [(p[0] - origin[0]) * scale[0], (p[1] - origin[1]) * scale[1]];
    let max = *bands.last().unwrap();
    let mut bounds = [0_f64; 4];
    let clipped: Vec<_> = pieces
        .iter()
        .filter(|p| p.start <= max)
        .map(|p| {
            let t = if p.duration <= 0. {
                1.
            } else {
                ((max - p.start) / p.duration).clamp(0., 1.)
            };
            let a = project(p.a);
            let full = project(p.b);
            let b = [a[0] + (full[0] - a[0]) * t, a[1] + (full[1] - a[1]) * t];
            for q in [a, b] {
                bounds[0] = bounds[0].min(q[0]);
                bounds[1] = bounds[1].min(q[1]);
                bounds[2] = bounds[2].max(q[0]);
                bounds[3] = bounds[3].max(q[1]);
            }
            (a, b, p.start, p.duration * t)
        })
        .collect();
    let resolution = ((bounds[2] - bounds[0]).max(bounds[3] - bounds[1]) / 500.).max(25.);
    let x0 = bounds[0] - resolution * 2.;
    let y0 = bounds[1] - resolution * 2.;
    let width = ((bounds[2] - bounds[0]) / resolution).ceil() as usize + 5;
    let height = ((bounds[3] - bounds[1]) / resolution).ceil() as usize + 5;
    let mut grid = vec![f64::INFINITY; width * height];
    for (a, b, t, duration) in &clipped {
        let steps = (((b[0] - a[0]).hypot(b[1] - a[1]) / resolution) * 2.)
            .ceil()
            .max(1.) as usize;
        for i in 0..=steps {
            let f = i as f64 / steps as f64;
            let p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
            let cost = t + duration * f;
            let x = ((p[0] - x0) / resolution).floor() as isize;
            let y = ((p[1] - y0) / resolution).floor() as isize;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (cx, cy) = (x + dx, y + dy);
                    if cx >= 0 && cy >= 0 && (cx as usize) < width && (cy as usize) < height {
                        let at = cy as usize * width + cx as usize;
                        grid[at] = grid[at].min(cost);
                    }
                }
            }
        }
    }
    let unproject = |p: [f64; 2]| {
        [
            origin[0] + (x0 + p[0] * resolution) / scale[0],
            origin[1] + (y0 + p[1] * resolution) / scale[1],
        ]
    };
    let features = bands
        .iter()
        .map(|&seconds| {
            let mask: Vec<_> = grid.iter().map(|v| *v <= seconds).collect();
            let rings = boundary(&mask, width, height);
            let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
            let mut holes = Vec::new();
            for ring in rings {
                if signed_area(&ring) > 0. {
                    polygons.push(vec![ring]);
                } else {
                    holes.push(ring);
                }
            }
            for hole in holes {
                if let Some(p) = polygons
                    .iter_mut()
                    .filter(|p| contains(hole[0], &p[0]))
                    .min_by(|a, b| signed_area(&a[0]).total_cmp(&signed_area(&b[0])))
                {
                    p.push(hole);
                }
            }
            for polygon in &mut polygons {
                for ring in polygon {
                    for p in ring {
                        *p = unproject(*p);
                    }
                }
            }
            Feature {
                kind: "Feature",
                properties: Properties {
                    seconds,
                    minutes: seconds / 60.,
                    area_km2: mask.iter().filter(|v| **v).count() as f64 * resolution * resolution
                        / 1e6,
                    approximate: true,
                },
                geometry: Geometry {
                    kind: "MultiPolygon",
                    coordinates: polygons,
                },
            }
        })
        .collect();
    Reachability {
        status: "reachable",
        start,
        visited,
        contours: FeatureCollection {
            kind: "FeatureCollection",
            features,
        },
        resolution_meters: resolution,
        segments: clipped.len(),
    }
}
fn signed_area(ring: &[[f64; 2]]) -> f64 {
    ring.windows(2)
        .map(|v| v[0][0] * v[1][1] - v[1][0] * v[0][1])
        .sum::<f64>()
        / 2.
}
fn contains(p: [f64; 2], ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    for v in ring.windows(2) {
        let (a, b) = (v[0], v[1]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
    }
    inside
}
fn boundary(mask: &[bool], w: usize, h: usize) -> Vec<Vec<[f64; 2]>> {
    let mut edges = BTreeMap::<usize, Vec<usize>>::new();
    let stride = w + 1;
    let mut add = |a, b| {
        edges.entry(a).or_default().push(b);
    };
    for y in 0..h {
        for x in 0..w {
            if !mask[y * w + x] {
                continue;
            }
            let v = y * stride + x;
            if y == 0 || !mask[(y - 1) * w + x] {
                add(v, v + 1);
            }
            if x + 1 == w || !mask[y * w + x + 1] {
                add(v + 1, v + 1 + stride);
            }
            if y + 1 == h || !mask[(y + 1) * w + x] {
                add(v + 1 + stride, v + stride);
            }
            if x == 0 || !mask[y * w + x - 1] {
                add(v + stride, v);
            }
        }
    }
    let point = |v: usize| [(v % stride) as f64, (v / stride) as f64];
    let mut rings = Vec::new();
    while let Some((&start, _)) = edges.first_key_value() {
        let mut at = start;
        let mut ring = vec![point(start)];
        let mut direction = [1., 0.];
        loop {
            let Some(nexts) = edges.get_mut(&at) else {
                break;
            };
            let p = point(at);
            let choice = nexts
                .iter()
                .enumerate()
                .max_by_key(|(_, v)| {
                    let q = point(**v);
                    let d = [q[0] - p[0], q[1] - p[1]];
                    let cross = direction[0] * d[1] - direction[1] * d[0];
                    let dot = direction[0] * d[0] + direction[1] * d[1];
                    if cross > 0. {
                        3
                    } else if dot > 0. {
                        2
                    } else if cross < 0. {
                        1
                    } else {
                        0
                    }
                })
                .unwrap()
                .0;
            let next = nexts.remove(choice);
            if nexts.is_empty() {
                edges.remove(&at);
            }
            let q = point(next);
            direction = [q[0] - p[0], q[1] - p[1]];
            if ring.len() >= 2 {
                let prev = ring[ring.len() - 2];
                if (p[0] - prev[0]) * direction[1] - (p[1] - prev[1]) * direction[0] == 0. {
                    ring.pop();
                }
            }
            ring.push(q);
            at = next;
            if at == start {
                break;
            }
        }
        if ring.len() >= 4 && ring.first() == ring.last() {
            rings.push(ring);
        }
    }
    rings
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contours_keep_holes_and_disconnected_components() {
        let mut m = vec![true; 25];
        m[12] = false;
        let rings = boundary(&m, 5, 5);
        assert_eq!(rings.len(), 2);
        assert_eq!(rings.iter().map(|r| signed_area(r)).sum::<f64>(), 24.);
        let r = boundary(&[true, false, false, true], 2, 2);
        assert_eq!(r.len(), 2);
        assert!(r.iter().all(|p| signed_area(p) == 1.));
    }
    #[test]
    fn bands_are_nested_and_clip_partial_edges() {
        let a = [16., 48.];
        let b = [16.01, 48.];
        let r = build(
            Snap {
                coordinates: a,
                distance_meters: 0.,
                way_id: "way/1".into(),
                segment: 0,
                t: 0.,
            },
            &[60., 120.],
            vec![Piece {
                a,
                b,
                start: 0.,
                duration: 300.,
            }],
            2,
        );
        assert_eq!(r.contours.features.len(), 2);
        assert!(
            r.contours.features[1].properties.area_km2 > r.contours.features[0].properties.area_km2
        );
        let max = r.contours.features[1]
            .geometry
            .coordinates
            .iter()
            .flatten()
            .flatten()
            .map(|p| p[0])
            .fold(0., f64::max);
        assert!(max < 16.007);
        assert!(crate::distance(a, b) > 500.);
    }
}
