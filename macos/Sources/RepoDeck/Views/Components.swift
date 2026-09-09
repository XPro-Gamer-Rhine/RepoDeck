import SwiftUI

/// Small pieces shared across the dashboard. Kept together so the tabs stay
/// about their own content rather than re-inventing a card border each time.

struct SectionCard<Content: View>: View {
    let title: String
    var subtitle: String?
    var systemImage: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage).foregroundStyle(.secondary)
                }
                Text(title).font(.headline)
                Spacer()
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            }
            content
        }
        .padding(14)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary, lineWidth: 0.5))
    }
}

struct StatTile: View {
    let value: String
    let label: String
    var tint: Color = .secondary
    var systemImage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                if let systemImage {
                    Image(systemName: systemImage).font(.caption2).foregroundStyle(tint)
                }
                Text(value).font(.system(.title3, design: .rounded)).bold().foregroundStyle(tint)
            }
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Repo status as one dot. Colour is the whole message, so it has a tooltip.
struct StatusDot: View {
    let status: String
    let deployState: String?

    private var color: Color {
        switch status {
        case "ready": return deployState == "running" ? .green : .accentColor
        case "indexing", "cloning": return .orange
        case "error": return .red
        default: return .secondary
        }
    }

    private var description: String {
        switch status {
        case "ready": return deployState == "running" ? "Indexed, app running" : "Indexed"
        case "indexing": return "Indexing"
        case "cloning": return "Cloning"
        case "error": return "Needs attention"
        default: return "Not indexed yet"
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .help(description)
    }
}

/// A horizontal bar whose colour tracks the heat ramp — used for hot files.
struct HeatBar: View {
    let value: Double
    var height: CGFloat = 6
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(GraphPalette.heatColor(value, dark: scheme == .dark))
                    .frame(width: max(2, geo.size.width * value.clamp(to: 0...1)))
            }
        }
        .frame(height: height)
    }
}

/// Merge volume per week, drawn small enough to sit inside a card header.
struct Sparkline: View {
    let values: [Double]
    var tint: Color = .accentColor

    var body: some View {
        GeometryReader { geo in
            let maximum = max(values.max() ?? 1, 1)
            Path { path in
                guard values.count > 1 else { return }
                let step = geo.size.width / CGFloat(values.count - 1)
                for (i, v) in values.enumerated() {
                    let x = CGFloat(i) * step
                    let y = geo.size.height * (1 - CGFloat(v / maximum))
                    if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                    else { path.addLine(to: CGPoint(x: x, y: y)) }
                }
            }
            .stroke(tint, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
    }
}

struct LayerBadge: View {
    let layer: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(GraphPalette.layerLabel(layer))
            .font(.caption2)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                GraphPalette.color(for: layer, heat: 0.6, dark: scheme == .dark).opacity(0.22),
                in: Capsule()
            )
            .overlay(Capsule().stroke(GraphPalette.color(for: layer, heat: 0.6, dark: scheme == .dark).opacity(0.5), lineWidth: 0.5))
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    var systemImage: String = "square.dashed"
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 34))
                .foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
    }
}

/// Dates from the engine arrive as sqlite's `YYYY-MM-DD HH:MM:SS` in UTC or as
/// ISO-8601 from git. One helper handles both and answers the only question the
/// UI ever asks: how long ago was that?
enum Timestamps {
    private static let sqlite: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let iso = ISO8601DateFormatter()

    static func parse(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return iso.date(from: value) ?? sqlite.date(from: value)
    }

    static func relative(_ value: String?) -> String {
        guard let date = parse(value) else { return "never" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    static func short(_ value: String?) -> String {
        guard let date = parse(value) else { return "—" }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

/// A relationship, spelled out the way the graph means it.
enum EdgeVocabulary {
    static func label(_ kind: String) -> String {
        switch kind {
        case "import": return "imports"
        case "route->controller": return "routes to"
        case "uses-middleware": return "uses middleware"
        case "calls": return "calls"
        case "renders": return "renders"
        case "related": return "related to"
        default: return kind
        }
    }

    static func summary(_ kinds: [String]) -> String {
        kinds.map(label).joined(separator: " and ")
    }
}
