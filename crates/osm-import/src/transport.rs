//! Explicit demo policies. Unknown access conditions are excluded, never guessed.
use osmpbfreader::Tags;
pub const MODES: [&str; 3] = ["walking", "cycling", "driving"];
fn tag<'a>(t: &'a Tags, k: &str) -> &'a str {
    t.get(k).map(|v| v.as_str()).unwrap_or("")
}
fn scopes(mode: usize) -> &'static [&'static str] {
    match mode {
        0 => &["access", "foot"],
        1 => &["access", "vehicle", "bicycle"],
        _ => &["access", "vehicle", "motor_vehicle", "motorcar"],
    }
}
fn allow(s: &str, default: bool) -> bool {
    match s {
        "" => default,
        "yes" | "designated" | "permissive" => true,
        _ => false,
    }
}
fn conditional(t: &Tags, mode: usize) -> bool {
    scopes(mode).iter().any(|s| {
        [
            format!("{s}:conditional"),
            format!("{s}:forward:conditional"),
            format!("{s}:backward:conditional"),
        ]
        .iter()
        .any(|k| !tag(t, k).is_empty())
    }) || [
        "oneway".to_string(),
        format!(
            "oneway:{}",
            if mode == 0 {
                "foot"
            } else if mode == 1 {
                "bicycle"
            } else {
                "motor_vehicle"
            }
        ),
        "oneway:motorcar".to_string(),
    ]
    .iter()
    .filter(|k| mode != 0 || k.as_str() == "oneway:foot")
    .any(|k| !tag(t, &format!("{k}:conditional")).is_empty())
}
pub fn blocked(t: &Tags, mode: usize) -> bool {
    if conditional(t, mode) {
        return true;
    }
    let default = match mode {
        0 => matches!(
            tag(t, "barrier"),
            "" | "no"
                | "gate"
                | "lift_gate"
                | "swing_gate"
                | "kissing_gate"
                | "bollard"
                | "cycle_barrier"
                | "entrance"
                | "stile"
        ),
        1 => matches!(
            tag(t, "barrier"),
            "" | "no" | "gate" | "lift_gate" | "swing_gate" | "bollard" | "entrance"
        ),
        _ => matches!(
            tag(t, "barrier"),
            "" | "no" | "gate" | "lift_gate" | "swing_gate" | "entrance" | "toll_booth"
        ),
    };
    !scopes(mode)
        .iter()
        .fold(default, |a, k| allow(tag(t, k), a))
}
pub fn directions(t: &Tags, mode: usize) -> u8 {
    if mode == 0 {
        return crate::walking::directions(t);
    }
    if conditional(t, mode) || tag(t, "area") == "yes" {
        return 0;
    }
    let h = tag(t, "highway");
    if ![
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "primary",
        "primary_link",
        "secondary",
        "secondary_link",
        "tertiary",
        "tertiary_link",
        "unclassified",
        "residential",
        "living_street",
        "service",
        "pedestrian",
        "track",
        "path",
        "footway",
        "steps",
        "cycleway",
        "bridleway",
        "road",
    ]
    .contains(&h)
    {
        return 0;
    }
    let default = if mode == 1 {
        ![
            "motorway",
            "motorway_link",
            "trunk",
            "trunk_link",
            "footway",
            "pedestrian",
            "steps",
            "bridleway",
        ]
        .contains(&h)
            && tag(t, "motorroad") != "yes"
    } else {
        ![
            "footway",
            "pedestrian",
            "steps",
            "cycleway",
            "bridleway",
            "path",
            "track",
        ]
        .contains(&h)
    };
    let mut permission = [default; 2];
    for key in scopes(mode) {
        for (i, d) in ["forward", "backward"].iter().enumerate() {
            permission[i] = allow(tag(t, key), permission[i]);
            permission[i] = allow(tag(t, &format!("{key}:{d}")), permission[i]);
        }
    }
    let implicit = if tag(t, "junction") == "roundabout" || h == "motorway" || h == "motorway_link"
    {
        "yes"
    } else {
        "no"
    };
    let mut oneway = tag(t, "oneway");
    if oneway.is_empty() {
        oneway = implicit;
    }
    if mode == 1 {
        let override_ = tag(t, "oneway:bicycle");
        if !override_.is_empty() {
            oneway = override_;
        } else if [
            "cycleway",
            "cycleway:left",
            "cycleway:right",
            "cycleway:both",
        ]
        .iter()
        .any(|k| tag(t, k).starts_with("opposite"))
        {
            oneway = "no";
        }
    } else {
        for k in ["oneway:motor_vehicle", "oneway:motorcar"] {
            if !tag(t, k).is_empty() {
                oneway = tag(t, k);
            }
        }
    }
    let bits = match oneway {
        "yes" | "1" | "true" => 1,
        "-1" => 2,
        "no" | "0" | "false" => 3,
        _ => 0,
    };
    bits & (u8::from(permission[0]) | u8::from(permission[1]) * 2)
}
fn speed_tag(value: &str) -> Option<f64> {
    let value = value.trim();
    let number = value
        .trim_end_matches("mph")
        .trim_end_matches("km/h")
        .trim()
        .parse::<f64>()
        .ok()?;
    (number.is_finite() && number > 0. && number <= 300.)
        .then_some(number * if value.ends_with("mph") { 1.609344 } else { 1. })
}
pub fn speeds(t: &Tags, mode: usize) -> [f64; 2] {
    let h = tag(t, "highway");
    let rough = [
        "gravel",
        "fine_gravel",
        "unpaved",
        "ground",
        "dirt",
        "sand",
        "mud",
        "cobblestone",
    ]
    .contains(&tag(t, "surface"));
    let base = match mode {
        0 => {
            if h == "steps" {
                2.5
            } else if rough {
                3.5
            } else {
                4.8
            }
        }
        1 => {
            if h == "steps" {
                4.
            } else if rough {
                8.
            } else if ["path", "track", "living_street"].contains(&h) {
                12.
            } else {
                18.
            }
        }
        _ => match h {
            "motorway" => 100.,
            "motorway_link" => 40.,
            "trunk" => 80.,
            "trunk_link" => 35.,
            "primary" => 50.,
            "secondary" => 40.,
            "tertiary" => 35.,
            "living_street" => 7.,
            "service" | "track" => 15.,
            _ => 25.,
        },
    };
    ["forward", "backward"].map(|d| {
        let mut speed: f64 = base;
        if mode != 0 {
            if let Some(v) = speed_tag(tag(t, &format!("maxspeed:{d}")))
                .or_else(|| speed_tag(tag(t, "maxspeed")))
            {
                speed = speed.min(v);
            }
        }
        speed.max(1.) / 3.6
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn tags(v: &[(&str, &str)]) -> Tags {
        v.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect()
    }
    #[test]
    fn mode_networks_and_specific_access_are_distinct() {
        let t = tags(&[("highway", "cycleway")]);
        assert_eq!(
            [directions(&t, 0), directions(&t, 1), directions(&t, 2)],
            [0, 3, 0]
        );
        let t = tags(&[
            ("highway", "residential"),
            ("vehicle", "no"),
            ("bicycle", "yes"),
        ]);
        assert_eq!(directions(&t, 1), 3);
        assert_eq!(directions(&t, 2), 0);
        assert_eq!(directions(&tags(&[("highway", "motorway")]), 2), 1);
        assert_eq!(directions(&tags(&[("highway", "footway")]), 2), 0);
    }
    #[test]
    fn direction_roundabouts_and_conditions() {
        let t = tags(&[
            ("highway", "residential"),
            ("oneway", "yes"),
            ("oneway:bicycle", "no"),
        ]);
        assert_eq!(directions(&t, 1), 3);
        assert_eq!(directions(&t, 2), 1);
        assert_eq!(
            directions(&tags(&[("highway", "residential"), ("oneway", "-1")]), 2),
            2
        );
        assert_eq!(
            directions(
                &tags(&[("highway", "residential"), ("junction", "roundabout")]),
                1
            ),
            1
        );
        assert_eq!(
            directions(
                &tags(&[
                    ("highway", "residential"),
                    ("motor_vehicle:conditional", "no @ (Mo-Fr)")
                ]),
                2
            ),
            0
        );
    }
    #[test]
    fn barriers_and_directional_speed_limits() {
        let t = tags(&[("barrier", "bollard")]);
        assert!(!blocked(&t, 0));
        assert!(!blocked(&t, 1));
        assert!(blocked(&t, 2));
        let t = tags(&[
            ("highway", "primary"),
            ("maxspeed:forward", "20"),
            ("maxspeed:backward", "20 mph"),
        ]);
        let s = speeds(&t, 2);
        assert!((s[0] - 20. / 3.6).abs() < 1e-6);
        assert!(s[1] > s[0]);
    }
}
