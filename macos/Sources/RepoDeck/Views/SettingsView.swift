import SwiftUI

/// App-wide settings: the GitHub account, and the models RepoDeck may use.
struct SettingsView: View {
    @EnvironmentObject private var app: AppModel
    @State private var tab = "ai"

    var body: some View {
        TabView(selection: $tab) {
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag("general")
            ProviderSettings()
                .tabItem { Label("AI", systemImage: "sparkles") }
                .tag("ai")
            GitHubSettings()
                .tabItem { Label("GitHub", systemImage: "person.crop.circle") }
                .tag("github")
            AboutSettings()
                .tabItem { Label("About", systemImage: "info.circle") }
                .tag("about")
        }
        .padding(14)
    }
}

struct GeneralSettings: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionCard(title: "Appearance", systemImage: "circle.lefthalf.filled") {
                AppearancePicker()
                    .pickerStyle(.inline)
                    .labelsHidden()
                Text("The graph palette inverts with the theme: heat reads as bright against a dark canvas and as deep and saturated against a light one.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

/// Any model, anywhere. A first-party key, or a local endpoint that speaks the
/// same protocol — the analysis pipeline does not care which, and neither does
/// the knowledge graph.
struct ProviderSettings: View {
    @EnvironmentObject private var app: AppModel
    @State private var editing: ProviderInfo?
    @State private var isNew = false
    @State private var testResult: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("RepoDeck uses a model to map each repository into layers and features, to extract the API surface and data model, and to write the knowledge graph your agents read.")
                .font(.callout)
                .foregroundStyle(.secondary)

            List {
                ForEach(app.providers) { provider in
                    HStack(spacing: 10) {
                        Image(systemName: icon(for: provider.kindValue))
                            .foregroundStyle(provider.unlocked ? .green : .orange)
                            .help(provider.unlocked ? "Key available" : "Key not unlocked — re-enter it")
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(provider.label).bold()
                                if provider.isDefault {
                                    Text("default")
                                        .font(.system(size: 9))
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(.tint.opacity(0.2), in: Capsule())
                                }
                            }
                            Text(provider.model + (provider.fastModel.map { " · fast: \($0)" } ?? ""))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            if let base = provider.baseUrl {
                                Text(base).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        Spacer()
                        Button("Test") {
                            Task {
                                switch await app.testProvider(provider) {
                                case .success(let ping):
                                    testResult = "\(provider.label): responded in \(ping.latencyMs) ms as \(ping.model)"
                                case .failure(let error):
                                    testResult = "\(provider.label): \(error.localizedDescription)"
                                }
                            }
                        }
                        Button("Edit") { editing = provider; isNew = false }
                        Button(role: .destructive) {
                            Task { await app.deleteProvider(provider) }
                        } label: {
                            Image(systemName: "trash")
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
            .frame(minHeight: 180)

            if let testResult {
                Text(testResult).font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Button {
                    editing = nil
                    isNew = true
                } label: {
                    Label("Add a provider", systemImage: "plus")
                }
                Spacer()
            }
        }
        .sheet(isPresented: Binding(
            get: { isNew || editing != nil },
            set: { if !$0 { isNew = false; editing = nil } }
        )) {
            ProviderEditor(existing: editing)
                .environmentObject(app)
        }
    }

    private func icon(for kind: ProviderKind) -> String {
        switch kind {
        case .anthropic: return "a.circle.fill"
        case .openai: return "o.circle.fill"
        case .compatible: return "desktopcomputer"
        }
    }
}

struct ProviderEditor: View {
    let existing: ProviderInfo?
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var kind: ProviderKind = .anthropic
    @State private var baseURL = ""
    @State private var model = ""
    @State private var fastModel = ""
    @State private var apiKey = ""
    @State private var effort = "high"
    @State private var isDefault = false
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(existing == nil ? "Add a provider" : "Edit \(existing!.label)").font(.headline)

            Picker("Provider", selection: $kind) {
                ForEach(ProviderKind.allCases) { Text($0.label).tag($0) }
            }
            .onChange(of: kind) { _, newValue in
                if model.isEmpty || existing == nil {
                    model = newValue.defaultModel
                    fastModel = newValue.defaultFastModel
                }
                if label.isEmpty { label = newValue.label }
            }

            Text(kind.blurb).font(.caption).foregroundStyle(.secondary)

            Form {
                TextField("Name", text: $label)
                    .help("How this provider appears in the repository picker")

                if kind.needsBaseURL {
                    TextField("Base URL", text: $baseURL)
                        .help("For example http://localhost:11434/v1 for Ollama, or http://localhost:1234/v1 for LM Studio")
                }

                TextField("Model", text: $model)
                TextField("Fast model (optional)", text: $fastModel)
                    .help("Used for the cheap bulk passes — feature grouping and module assignment. Falls back to the main model.")

                if kind.needsKey || !baseURL.isEmpty {
                    SecureField(existing?.unlocked == true ? "API key (leave blank to keep)" : "API key", text: $apiKey)
                }

                Picker("Effort", selection: $effort) {
                    Text("Low — cheapest, roughest").tag("low")
                    Text("Medium").tag("medium")
                    Text("High — recommended").tag("high")
                    Text("Extra high").tag("xhigh")
                }
                .help("How hard the model thinks about each pass. Higher effort mostly shows up in the knowledge graph's accuracy.")

                Toggle("Use this by default", isOn: $isDefault)
            }
            .formStyle(.grouped)

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Text("Keys are stored in your Keychain and handed to the engine over a pipe — never written to RepoDeck's database or passed on a command line.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(label.isEmpty || model.isEmpty || busy)
            }
        }
        .padding(18)
        .frame(width: 560)
        .onAppear {
            if let existing {
                label = existing.label
                kind = existing.kindValue
                baseURL = existing.baseUrl ?? ""
                model = existing.model
                fastModel = existing.fastModel ?? ""
                effort = existing.effort
                isDefault = existing.isDefault
            } else {
                kind = .anthropic
                label = ProviderKind.anthropic.label
                model = ProviderKind.anthropic.defaultModel
                fastModel = ProviderKind.anthropic.defaultFastModel
                isDefault = app.providers.isEmpty
            }
        }
    }

    private func save() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await app.saveProvider(
                id: existing?.id,
                label: label,
                kind: kind,
                baseURL: baseURL,
                model: model,
                fastModel: fastModel,
                apiKey: apiKey.isEmpty ? nil : apiKey,
                effort: effort,
                isDefault: isDefault
            )
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct GitHubSettings: View {
    @EnvironmentObject private var app: AppModel
    @State private var clientId = ""
    @State private var token = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let account = app.account {
                SectionCard(title: "Signed in", systemImage: "person.crop.circle.badge.checkmark") {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(account.displayName).bold()
                            Text("@\(account.login)").font(.caption).foregroundStyle(.secondary)
                            Text("Scopes: \(account.scopes.joined(separator: ", "))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Button("Sign out") { Task { await app.signOut() } }
                    }
                    if !account.canReadPrivate {
                        Label("This token has no `repo` scope, so private repositories will not appear.", systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            } else {
                SectionCard(title: "Connect GitHub", systemImage: "person.crop.circle") {
                    HStack {
                        SecureField("Personal access token", text: $token)
                            .textFieldStyle(.roundedBorder)
                        Button("Connect") {
                            Task {
                                do { try await app.signIn(withToken: token); token = "" }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                        .disabled(token.count < 20)
                    }
                    Button("Use my gh CLI token") {
                        Task {
                            do { try await app.signInWithGitHubCLI() }
                            catch { self.error = error.localizedDescription }
                        }
                    }
                }
            }

            SectionCard(title: "Device sign-in", systemImage: "key") {
                Text("Signing in on github.com needs an OAuth App client ID. Create one under Settings → Developer settings → OAuth Apps with \"Enable Device Flow\" ticked. There is no client secret in this flow.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    TextField("Client ID", text: $clientId)
                        .textFieldStyle(.roundedBorder)
                    Button("Save") { Task { await app.saveGitHubClientID(clientId) } }
                }
            }

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }

            Spacer()
        }
        .onAppear { clientId = app.githubClientId }
    }
}

struct AboutSettings: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("RepoDeck").font(.title2).bold()
            Text("Watch every repository you work on: pull on a schedule or when a pull request merges, resolve the merge, redeploy locally, and keep a knowledge graph your Claude agents can read.")
                .font(.callout)
                .foregroundStyle(.secondary)

            SectionCard(title: "Where things live", systemImage: "folder") {
                row("Clones", "~/Library/Application Support/RepoDeck/repos")
                row("Database", "~/Library/Application Support/RepoDeck/data/repodeck.db")
                row("Deploy logs", "~/Library/Application Support/RepoDeck/logs")
                row("Exports", "~/Library/Application Support/RepoDeck/exports")
                row("Secrets", "macOS Keychain — never the database")
            }

            SectionCard(title: "Engine", systemImage: "gearshape.2") {
                Text(app.engine.isReady ? "Running" : "Not running")
                    .font(.caption)
                    .foregroundStyle(app.engine.isReady ? .green : .orange)
                if let error = app.engine.startupError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }

            Spacer()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 90, alignment: .leading)
            Text(value).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
            Spacer()
        }
    }
}
