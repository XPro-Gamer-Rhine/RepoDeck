import SwiftUI

/// Adding a repository is two steps on purpose.
///
/// First RepoDeck looks at the remote — which branches exist, which one the
/// remote itself calls HEAD, whether it is private. Only then does the form
/// commit anything, so the branch picker has real data in it and a typo in a
/// URL fails here rather than halfway through a clone.
struct AddRepoView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var url = ""
    @State private var inspection: RemoteInspection?
    @State private var branch = ""
    @State private var branchAuto = true
    @State private var providerId: Int?
    @State private var pullStrategy = "reset"
    @State private var aiConflictFix = false
    @State private var autoDeploy = false
    @State private var watchPrs = true
    @State private var watchMinutes = 60
    @State private var cron = "0 3 * * *"
    @State private var sshKeyPath = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showPicker = false
    @State private var search = ""

    private var isSSH: Bool { !url.hasPrefix("http") && url.contains("@") }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    urlSection
                    if let inspection { detailsSection(inspection) }
                }
                .padding(18)
            }
            Divider()
            footer
        }
        .frame(width: 660, height: 620)
        .task { if app.account != nil && app.remoteRepos.isEmpty { await app.loadRemoteRepos() } }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Add a repository").font(.headline)
                Text("Paste an SSH or HTTPS URL, or pick one of your GitHub repositories.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(16)
    }

    private var urlSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("git@github.com:acme/widgets.git", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await inspect() } }

                if app.account != nil {
                    Button {
                        showPicker.toggle()
                    } label: {
                        Label("My repos", systemImage: "list.bullet")
                    }
                    .popover(isPresented: $showPicker, arrowEdge: .bottom) { repoPicker }
                }

                Button("Check") { Task { await inspect() } }
                    .disabled(url.isEmpty || busy)
            }

            if isSSH {
                HStack {
                    TextField("SSH key path (optional — your agent is used by default)", text: $sshKeyPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                    Button("Choose…") { chooseKey() }
                }
            }

            if busy { ProgressView().controlSize(.small) }

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private var repoPicker: some View {
        VStack(spacing: 0) {
            TextField("Filter", text: $search)
                .textFieldStyle(.roundedBorder)
                .padding(8)
            Divider()
            if app.isLoadingRemoteRepos {
                ProgressView().padding()
            } else {
                List {
                    ForEach(filteredRemote) { remote in
                        Button {
                            url = remote.sshUrl ?? remote.httpsUrl ?? ""
                            showPicker = false
                            Task { await inspect() }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(remote.fullName).font(.callout)
                                    if let description = remote.description {
                                        Text(description).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                                Spacer()
                                if remote.private { Image(systemName: "lock").font(.caption2).foregroundStyle(.secondary) }
                                if let language = remote.language {
                                    Text(language).font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .listStyle(.plain)
            }
        }
        .frame(width: 420, height: 380)
    }

    private var filteredRemote: [GitHubRepo] {
        let needle = search.lowercased()
        guard !needle.isEmpty else { return app.remoteRepos }
        return app.remoteRepos.filter { $0.fullName.lowercased().contains(needle) }
    }

    private func detailsSection(_ inspection: RemoteInspection) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionCard(title: inspection.name, subtitle: inspection.private == true ? "private" : nil, systemImage: "shippingbox") {
                if let description = inspection.description {
                    Text(description).font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Picker("Default branch", selection: $branch) {
                        ForEach(inspection.branches, id: \.self) { Text($0).tag($0) }
                    }
                    .frame(maxWidth: 280)
                    Toggle("Follow the remote", isOn: $branchAuto)
                        .toggleStyle(.checkbox)
                        .help("Re-read the remote's own HEAD before each sync, so a team renaming master to main doesn't leave RepoDeck watching a dead branch.")
                }
                Text("\(inspection.branches.count) branches · found via \(inspection.via == "api" ? "the GitHub API" : "git")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            SectionCard(title: "Keeping it current", systemImage: "clock.arrow.2.circlepath") {
                HStack {
                    Picker("Schedule", selection: $cron) {
                        Text("Every hour").tag("0 * * * *")
                        Text("Every 6 hours").tag("0 */6 * * *")
                        Text("Daily at 03:00").tag("0 3 * * *")
                        Text("Weekly (Monday)").tag("0 3 * * 1")
                        Text("Never").tag("off")
                    }
                    .frame(maxWidth: 260)
                }
                Toggle("Watch for merged pull requests", isOn: $watchPrs)
                    .toggleStyle(.checkbox)
                if watchPrs {
                    HStack {
                        Text("Check every").font(.caption)
                        Stepper("\(watchMinutes) minutes", value: $watchMinutes, in: 5...720, step: 5)
                            .frame(maxWidth: 200)
                    }
                    .foregroundStyle(.secondary)
                }
            }

            SectionCard(title: "Pulling", systemImage: "arrow.down.circle") {
                Picker("When new code lands", selection: $pullStrategy) {
                    Text("Reset to origin — the clone is a mirror").tag("reset")
                    Text("Merge — keep local commits").tag("merge")
                }
                .pickerStyle(.radioGroup)

                Text(pullStrategy == "reset"
                     ? "RepoDeck always fetches first, then makes the working tree match the remote exactly. No conflict is possible because nothing of yours is in it. If you do commit something locally, RepoDeck notices and upgrades to a real merge instead of throwing it away."
                     : "A real merge, so your local commits survive. Conflicts stop the pipeline until they are resolved.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("Let AI propose merge-conflict resolutions", isOn: $aiConflictFix)
                    .toggleStyle(.checkbox)
                if aiConflictFix {
                    Text("Unattended runs apply a resolution only when the model is confident in every conflicted file. Anything less waits for you, with the proposal and a three-way diff on record.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            SectionCard(title: "Running it locally", systemImage: "play.rectangle") {
                Toggle("Redeploy automatically after every merge", isOn: $autoDeploy)
                    .toggleStyle(.checkbox)
                Text("RepoDeck detects the run command after cloning and shows it to you before anything executes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !app.providers.isEmpty {
                SectionCard(title: "Analysis", systemImage: "sparkles") {
                    Picker("Model", selection: $providerId) {
                        Text("Default (\(app.providers.first(where: { $0.isDefault })?.label ?? "none"))").tag(Int?.none)
                        ForEach(app.providers) { provider in
                            Text(provider.label).tag(Int?.some(provider.id))
                        }
                    }
                }
            }
        }
    }

    private var footer: some View {
        HStack {
            if inspection != nil {
                Text("RepoDeck will clone into ~/Library/Application Support/RepoDeck/repos and index it.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Cancel") { dismiss() }
            Button("Add and index") { Task { await add() } }
                .buttonStyle(.borderedProminent)
                .disabled(inspection == nil || busy)
        }
        .padding(14)
    }

    // MARK: - Actions

    private func chooseKey() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
        if panel.runModal() == .OK, let picked = panel.url {
            sshKeyPath = picked.path
        }
    }

    private func inspect() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let credentialRef = try storeCredentialIfNeeded()
            let result = try await app.inspect(url: url.trimmingCharacters(in: .whitespaces), credentialRef: credentialRef)
            inspection = result
            branch = result.suggested
        } catch {
            self.error = error.localizedDescription
            inspection = nil
        }
    }

    /// The SSH key path is a secret by our own rules: it goes into the Keychain
    /// and the database only ever sees the ref.
    private func storeCredentialIfNeeded() throws -> String? {
        if isSSH, !sshKeyPath.isEmpty {
            let ref = SecretStore.ref("ssh", url)
            guard SecretStore.set(sshKeyPath, for: ref) else {
                throw EngineError(message: "Could not save the SSH key path to the Keychain.")
            }
            return ref
        }
        // HTTPS uses the signed-in account's token, which the engine already holds.
        if !isSSH, app.account != nil { return SecretStore.ref("github", "token") }
        return nil
    }

    private func add() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let credentialRef = try storeCredentialIfNeeded()
            if credentialRef != nil { await app.pushSecrets() }

            var params: [String: Any] = [
                "url": url.trimmingCharacters(in: .whitespaces),
                "branch": branch,
                "branchAuto": branchAuto,
                "cron": cron,
                "timezone": TimeZone.current.identifier,
                "watchPrs": watchPrs,
                "watchIntervalMin": watchMinutes,
                "pullStrategy": pullStrategy,
                "aiConflictFix": aiConflictFix,
                "autoDeploy": autoDeploy,
            ]
            if let credentialRef {
                params["credentialRef"] = credentialRef
                params["authType"] = isSSH ? "ssh" : "token"
            }
            if let providerId { params["providerId"] = providerId }

            _ = try await app.addRepo(params)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
