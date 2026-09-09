import SwiftUI

/// First launch: connect a GitHub account.
///
/// Three routes in, ordered by how much work they cost. If the GitHub CLI is
/// already signed in on this Mac, the first button is the whole flow and no new
/// credential comes into existence.
struct OnboardingView: View {
    @EnvironmentObject private var app: AppModel

    @State private var busy = false
    @State private var error: String?
    @State private var pastedToken = ""
    @State private var device: DeviceCodeStart?
    @State private var pollTask: Task<Void, Never>?
    @State private var clientId = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                header

                VStack(spacing: 12) {
                    cliOption
                    deviceOption
                    tokenOption
                }
                .frame(maxWidth: 560)

                if let error {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 560)
                }

                Button("Skip — I'll add repositories by SSH URL") {
                    // A repo can still be added by URL; only the PR watcher and
                    // the repository picker need an account.
                    app.selectedRepoID = nil
                    app.show(.init(
                        level: .info,
                        title: "Working without a GitHub account",
                        detail: "Cloning and analysis work. The pull-request watcher falls back to polling the branch with git."
                    ))
                }
                .buttonStyle(.link)
                .font(.callout)
            }
            .padding(40)
            .frame(maxWidth: .infinity)
        }
        .onAppear { clientId = app.githubClientId }
        .onDisappear { pollTask?.cancel() }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text("RepoDeck").font(.largeTitle).bold()
            Text("Watch every repository you work on: pull on a schedule, redeploy on every merge, and keep a knowledge graph your Claude agents can read.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            Text("Connect GitHub to see your repositories and watch pull requests.")
                .font(.callout)
                .padding(.top, 6)
        }
    }

    private var cliOption: some View {
        SectionCard(title: "Use the GitHub CLI", subtitle: "fastest", systemImage: "terminal") {
            Text("If `gh auth login` has already run on this Mac, RepoDeck can borrow that token. Nothing new is created.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                Task { await runCLI() }
            } label: {
                if busy { ProgressView().controlSize(.small) } else { Text("Use my gh CLI token") }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
        }
    }

    private var deviceOption: some View {
        SectionCard(title: "Sign in on github.com", systemImage: "key") {
            if let device {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Enter this code at \(device.verificationUri)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack {
                        Text(device.userCode)
                            .font(.system(.title2, design: .monospaced))
                            .bold()
                            .textSelection(.enabled)
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(device.userCode, forType: .string)
                        }
                        Button("Open GitHub") {
                            if let url = URL(string: device.verificationUri) { NSWorkspace.shared.open(url) }
                        }
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                    Button("Cancel") {
                        pollTask?.cancel()
                        self.device = nil
                    }
                    .buttonStyle(.link)
                }
            } else {
                Text("Device sign-in needs a GitHub OAuth App client ID. Create one at github.com/settings/developers with \"Device flow\" enabled — there is no client secret involved, so nothing sensitive is stored.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    TextField("Client ID (Iv1.…)", text: $clientId)
                        .textFieldStyle(.roundedBorder)
                    Button("Start") {
                        Task { await startDevice() }
                    }
                    .disabled(clientId.isEmpty || busy)
                }
            }
        }
    }

    private var tokenOption: some View {
        SectionCard(title: "Paste a personal access token", systemImage: "doc.on.clipboard") {
            Text("Needs the `repo` scope for private repositories, `read:org` to see organisation ones. Stored in your Keychain — the token never touches RepoDeck's database.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                SecureField("ghp_… or github_pat_…", text: $pastedToken)
                    .textFieldStyle(.roundedBorder)
                Button("Connect") {
                    Task { await connect(token: pastedToken) }
                }
                .disabled(pastedToken.count < 20 || busy)
            }
        }
    }

    // MARK: - Actions

    private func runCLI() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await app.signInWithGitHubCLI()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func connect(token: String) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await app.signIn(withToken: token.trimmingCharacters(in: .whitespacesAndNewlines))
            pastedToken = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func startDevice() async {
        busy = true
        error = nil
        defer { busy = false }
        await app.saveGitHubClientID(clientId)
        do {
            let started = try await app.startDeviceFlow()
            device = started
            poll(started)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// GitHub asks us to poll at the interval it names, and to back off further
    /// when it says so. Doing anything faster gets the request rejected.
    private func poll(_ started: DeviceCodeStart) {
        pollTask?.cancel()
        pollTask = Task {
            var interval = started.interval
            let deadline = Date().addingTimeInterval(TimeInterval(started.expiresIn))

            while !Task.isCancelled && Date() < deadline {
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                if Task.isCancelled { return }
                do {
                    let result = try await app.pollDeviceFlow(deviceCode: started.deviceCode)
                    if let token = result.token {
                        await connect(token: token)
                        device = nil
                        return
                    }
                    if result.slowDown == true { interval = result.interval ?? (interval + 5) }
                } catch {
                    self.error = error.localizedDescription
                    device = nil
                    return
                }
            }
            if device != nil {
                error = "The sign-in code expired. Start again."
                device = nil
            }
        }
    }
}
