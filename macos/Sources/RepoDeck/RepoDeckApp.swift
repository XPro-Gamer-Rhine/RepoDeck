import SwiftUI

@main
struct RepoDeckApp: App {
    @StateObject private var app = AppModel()
    @Environment(\.openWindow) private var openWindow
    @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.system.rawValue

    /// The View menu needs a binding, and @AppStorage cannot be projected from
    /// inside a `commands` builder — so it is hoisted out here.
    private var appearanceBinding: Binding<String> {
        Binding(get: { appearance }, set: { appearance = $0 })
    }

    var body: some Scene {
        WindowGroup("RepoDeck") {
            MainWindowView()
                .environmentObject(app)
                .appearanceControlled()
                .frame(minWidth: 1100, minHeight: 720)
                .task { await app.boot() }
                .onDisappear { app.shutdown() }
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                Picker("Appearance", selection: appearanceBinding) {
                    ForEach(AppAppearance.allCases) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                }
                Divider()
            }
            CommandMenu("Repository") {
                Button("Sync now") {
                    guard let id = app.selectedRepoID else { return }
                    Task { _ = try? await app.engine.call("sched.runNow", ["repoId": id], as: JSONValue.self) }
                }
                .keyboardShortcut("r", modifiers: [.command])
                .disabled(app.selectedRepoID == nil)

                Button("Check for new merges") {
                    guard let id = app.selectedRepoID else { return }
                    Task { _ = try? await app.engine.call("sched.checkNow", ["repoId": id], as: JSONValue.self) }
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(app.selectedRepoID == nil)
            }
        }

        // A menubar item so a running deploy and a mid-flight sync are visible
        // without bringing the window forward.
        MenuBarExtra("RepoDeck", systemImage: "point.3.filled.connected.trianglepath.dotted") {
            MenuBarView()
                .environmentObject(app)
                .appearanceControlled()
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(app)
                .appearanceControlled()
                .frame(width: 660, height: 560)
        }
    }
}
