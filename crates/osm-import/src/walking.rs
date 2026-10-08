//! Explicit prototype profile, not a claim about national access-law defaults.
use osmpbfreader::Tags;
fn tag<'a>(tags: &'a Tags, key: &str) -> &'a str {
    tags.get(key).map(|s| s.as_str()).unwrap_or("")
}
fn allowed(value: &str, default: bool) -> bool {
    match value {
        "" => default,
        "yes" | "designated" | "permissive" => true,
        _ => false,
    }
}
fn conditional(tags: &Tags) -> bool {
    [
        "access:conditional",
        "foot:conditional",
        "oneway:foot:conditional",
        "foot:forward:conditional",
        "foot:backward:conditional",
    ]
    .iter()
    .any(|key| !tag(tags, key).is_empty())
}
pub fn node_blocked(tags: &Tags) -> bool {
    if conditional(tags) {
        return true;
    }
    let default = matches!(
        tag(tags, "barrier"),
        "" | "no"
            | "gate"
            | "lift_gate"
            | "swing_gate"
            | "kissing_gate"
            | "bollard"
            | "cycle_barrier"
            | "entrance"
            | "stile"
    );
    let access = if tag(tags, "foot").is_empty() {
        tag(tags, "access")
    } else {
        tag(tags, "foot")
    };
    !allowed(access, default)
}
pub fn directions(tags: &Tags) -> u8 {
    if conditional(tags) || tag(tags, "area") == "yes" {
        return 0;
    }
    let highway = tag(tags, "highway");
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
    ]
    .contains(&highway)
    {
        return 0;
    }
    let default = ![
        "motorway",
        "motorway_link",
        "trunk",
        "trunk_link",
        "cycleway",
        "bridleway",
    ]
    .contains(&highway)
        && tag(tags, "motorroad") != "yes";
    let access = if tag(tags, "foot").is_empty() {
        tag(tags, "access")
    } else {
        tag(tags, "foot")
    };
    let base = allowed(access, default);
    let mut bits = 0;
    if allowed(tag(tags, "foot:forward"), base) {
        bits |= 1;
    }
    if allowed(tag(tags, "foot:backward"), base) {
        bits |= 2;
    }
    // Ordinary oneway is a vehicle rule. Foot has its own explicit direction tag.
    match tag(tags, "oneway:foot") {
        "yes" | "1" | "true" => bits & 1,
        "-1" => bits & 2,
        "" | "no" | "0" | "false" => bits,
        _ => 0,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn tags(items: &[(&str, &str)]) -> Tags {
        items
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }
    #[test]
    fn specific_foot_access_overrides_generic_access() {
        assert_eq!(
            directions(&tags(&[("highway", "path"), ("access", "private")])),
            0
        );
        assert_eq!(
            directions(&tags(&[
                ("highway", "path"),
                ("access", "private"),
                ("foot", "yes")
            ])),
            3
        );
        assert_eq!(
            directions(&tags(&[("highway", "path"), ("foot", "use_sidepath")])),
            0
        );
    }
    #[test]
    fn pedestrian_direction_is_distinct_from_vehicle_oneway() {
        assert_eq!(
            directions(&tags(&[("highway", "residential"), ("oneway", "yes")])),
            3
        );
        assert_eq!(
            directions(&tags(&[("highway", "footway"), ("oneway:foot", "yes")])),
            1
        );
        assert_eq!(
            directions(&tags(&[("highway", "footway"), ("oneway:foot", "-1")])),
            2
        );
        assert_eq!(
            directions(&tags(&[("highway", "footway"), ("foot:forward", "no")])),
            2
        );
    }
    #[test]
    fn conservative_defaults_and_unsupported_conditions() {
        for highway in [
            "motorway",
            "trunk",
            "construction",
            "proposed",
            "cycleway",
            "bridleway",
        ] {
            assert_eq!(directions(&tags(&[("highway", highway)])), 0);
        }
        assert_eq!(
            directions(&tags(&[("highway", "cycleway"), ("foot", "yes")])),
            3
        );
        assert_eq!(
            directions(&tags(&[
                ("highway", "path"),
                ("foot:conditional", "no @ (sunset-sunrise)")
            ])),
            0
        );
        assert_eq!(
            directions(&tags(&[("highway", "pedestrian"), ("area", "yes")])),
            0
        );
    }
    #[test]
    fn node_access_and_barriers_are_respected() {
        assert!(node_blocked(&tags(&[
            ("barrier", "gate"),
            ("access", "private")
        ])));
        assert!(!node_blocked(&tags(&[
            ("barrier", "gate"),
            ("access", "private"),
            ("foot", "yes")
        ])));
        assert!(node_blocked(&tags(&[("barrier", "wall")])));
        assert!(!node_blocked(&tags(&[("barrier", "bollard")])));
    }
}
