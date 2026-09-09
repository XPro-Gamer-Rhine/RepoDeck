import SwiftUI

/// Light, dark, or whatever the Mac is set to.
///
/// The graph is the reason this is a first-class setting rather than something
/// inherited silently: its palette inverts between themes — hot reads as bright
/// against a dark canvas and as deep and saturated against a light one — so
/// being able to pin the theme is being able to pin how the map reads.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "Match system"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }

    /// `nil` hands the decision back to macOS.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    static let storageKey = "appearance"
}

/// Applies the stored appearance, and re-applies it when the setting changes.
struct AppearanceModifier: ViewModifier {
    @AppStorage(AppAppearance.storageKey) private var stored = AppAppearance.system.rawValue

    func body(content: Content) -> some View {
        content.preferredColorScheme(AppAppearance(rawValue: stored)?.colorScheme)
    }
}

extension View {
    func appearanceControlled() -> some View { modifier(AppearanceModifier()) }
}

struct AppearancePicker: View {
    @AppStorage(AppAppearance.storageKey) private var stored = AppAppearance.system.rawValue

    var body: some View {
        Picker("Appearance", selection: $stored) {
            ForEach(AppAppearance.allCases) { option in
                Label(option.label, systemImage: option.symbol).tag(option.rawValue)
            }
        }
    }
}
