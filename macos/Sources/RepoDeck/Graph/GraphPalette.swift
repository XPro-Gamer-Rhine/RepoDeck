import SwiftUI

/// Two things are encoded in every node at once.
///
/// **Hue says what a node is** — a route is red wherever it appears, a model is
/// yellow. **Brightness and glow say how much it changes.** A stable route is a
/// deep, dark red; a route merged into every week is a bright one with a halo
/// around it. Because hue never moves, the eye can read "what" and "how hot"
/// independently instead of trading one off against the other.
enum GraphPalette {
    /// Hue in degrees, and the base saturation each layer reads best at.
    private static let layerHue: [String: (h: Double, s: Double)] = [
        "route":      (352, 0.78),
        "controller": (214, 0.72),
        "middleware": (272, 0.66),
        "service":    (188, 0.70),
        "engine":     (26,  0.82),
        "model":      (46,  0.80),
        "page":       (322, 0.68),
        "component":  (162, 0.62),
        "job":        (128, 0.62),
        "config":     (210, 0.16),
        "test":       (220, 0.10),
        "infra":      (16,  0.30),
        "other":      (240, 0.08),
    ]

    static let layerOrder = [
        "route", "controller", "middleware", "service", "engine", "model",
        "page", "component", "job", "config", "test", "infra", "other",
    ]

    static func layerLabel(_ layer: String) -> String {
        switch layer {
        case "route": return "Routes"
        case "controller": return "Controllers"
        case "middleware": return "Middleware"
        case "service": return "Services"
        case "engine": return "Engines"
        case "model": return "Models"
        case "page": return "Pages"
        case "component": return "Components"
        case "job": return "Jobs"
        case "config": return "Config"
        case "test": return "Tests"
        case "infra": return "Infra"
        default: return layer.capitalized
        }
    }

    /// A stable hue for an arbitrary string — used for folder, feature and
    /// cluster colouring, where the categories are whatever the repo happens to
    /// have. The golden-ratio step keeps neighbouring names far apart in hue.
    static func hue(forKey key: String) -> Double {
        var hasher: UInt64 = 5381
        for byte in key.utf8 { hasher = (hasher &* 33) &+ UInt64(byte) }
        return Double(hasher % 360)
    }

    static func hue(forCluster cluster: Int) -> Double {
        cluster < 0 ? 220 : (Double(cluster) * 137.508).truncatingRemainder(dividingBy: 360)
    }

    /// The fill for a node.
    ///
    /// Heat drives lightness in the direction that reads as "hot" for the
    /// theme: bright against a dark canvas, deep and saturated against a light one.
    static func fill(hue: Double, saturation: Double, heat: Double, dark: Bool) -> Color {
        let h = heat.clamp(to: 0...1)
        if dark {
            return Color(hue: hue / 360, saturation: saturation, brightness: 0.34 + 0.62 * h)
        }
        return Color(hue: hue / 360, saturation: 0.35 + 0.55 * saturation * (0.4 + 0.6 * h),
                     brightness: 0.92 - 0.42 * h)
    }

    static func hueAndSaturation(for layer: String) -> (Double, Double) {
        let entry = layerHue[layer] ?? layerHue["other"]!
        return (entry.h, entry.s)
    }

    static func color(for layer: String, heat: Double = 0.75, dark: Bool = true) -> Color {
        let (h, s) = hueAndSaturation(for: layer)
        return fill(hue: h, saturation: s, heat: heat, dark: dark)
    }

    /// Edge colour: inherits the source node's hue so a dense graph still reads
    /// as "these lines come from here", but muted so edges never fight nodes.
    static func edgeColor(hue: Double, inferred: Bool, dark: Bool) -> Color {
        Color(hue: hue / 360,
              saturation: inferred ? 0.30 : 0.48,
              brightness: dark ? 0.72 : 0.46)
            .opacity(inferred ? 0.28 : 0.42)
    }

    /// The ramp used by the heat legend and the hotspot bars.
    static func heatColor(_ heat: Double, dark: Bool) -> Color {
        let h = heat.clamp(to: 0...1)
        // Cool blue for cold, through amber, to red at the top.
        let hue = 210.0 - 210.0 * h
        return Color(hue: hue / 360, saturation: 0.30 + 0.55 * h, brightness: dark ? 0.55 + 0.35 * h : 0.85 - 0.3 * h)
    }
}

extension Comparable {
    /// Named `clamp` rather than `clamped` so it never collides with the
    /// package-internal `clamped` the SDK already ships.
    func clamp(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
