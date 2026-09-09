import Foundation
import SwiftUI

/// One line in the activity strip along the bottom of the window.
struct ActivityLine: Identifiable, Hashable {
    let id = UUID()
    let at: Date
    let repoId: Int?
    let kind: String
    let text: String

    var isError: Bool { kind.contains("error") || kind == "fatal" || kind == "sync_blocked" }
}

/// The root store: the engine connection, the signed-in account, the configured
/// providers, and the repositories. Everything a screen needs that is not about
/// one specific repository lives here.
@MainActor
final class AppModel: ObservableObject {
    let engine = EngineClient()

    @Published var account: Account?
    @Published var providers: [ProviderInfo] = []
    @Published var repos: [Repo] = []
    @Published var schedules: [ScheduleInfo] = []
    @Published var githubClientId: String = ""

    @Published var selectedRepoID: Int?
    @Published var activity: [ActivityLine] = []
    @Published var banner: Banner?
    @Published var isBooting = true
    /// False until the Keychain has been read and handed to the engine. Until
    /// then, anything needing a credential will fail with a clear message rather
    /// than a mysterious one.
    @Published var secretsUnlocked = false

    /// Repositories the signed-in account can see, loaded on demand for the picker.
    @Published var remoteRepos: [GitHubRepo] = []
    @Published var isLoadingRemoteRepos = false

    struct Banner: Identifiable, Equatable {
        enum Level { case info, warning, error, success }
        let id = UUID()
        let level: Level
        let title: String
        let detail: String?
    }

    var selectedRepo: Repo? {
        repos.first { $0.id == selectedRepoID }
    }

    var hasProvider: Bool { !providers.isEmpty }

    // MARK: - Boot

    func boot() async {
        engine.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        // A restarted engine is a blank one: it has no credentials and no running
        // schedules until we hand them back.
        engine.onRestart = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.banner = Banner(
                    level: .warning,
                    title: "The engine restarted",
                    detail: "Schedules and credentials have been restored. Anything it was running was stopped."
                )
                await self.pushSecrets()
            }
        }
        engine.start()

        if let error = engine.startupError {
            banner = Banner(level: .error, title: "The engine could not start", detail: error)
            isBooting = false
            return
        }

        // The daemon announces itself with a `ready` event; nothing works before it.
        //
        // A `for … where` here would be a trap: `where` filters which iterations
        // run their body, it does not stop the loop — so the app would sit on the
        // splash for the full timeout on every launch, however fast the engine
        // actually came up.
        let deadline = Date().addingTimeInterval(10)
        while !engine.isReady && Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        if !engine.isReady {
            banner = Banner(
                level: .error,
                title: "The engine did not start",
                detail: engine.startupError ?? "It did not respond within ten seconds."
            )
            isBooting = false
            return
        }

        // The window comes up as soon as the engine answers. Unlocking the
        // Keychain happens after, and deliberately does not gate the UI.
        await refresh()
        isBooting = false

        Task { await pushSecrets() }
    }

    /// Hand the engine every credential we hold. This is what unlocks git
    /// access, model calls and the pull-request watchers, and it is what starts
    /// the schedulers.
    ///
    /// The Keychain reads happen off the main actor on purpose. macOS blocks a
    /// `SecItemCopyMatching` behind an authorization prompt whenever the asking
    /// app's code signature is not on the item's ACL — which is the normal state
    /// for a locally built, ad-hoc-signed copy. Doing that read on the main
    /// thread froze the app on its splash screen with no explanation and no way
    /// out, which is exactly the wrong response to "macOS wants to ask you
    /// something".
    func pushSecrets() async {
        let bundle = await Task.detached(priority: .userInitiated) {
            SecretStore.bundle(for: SecretStore.allRefs())
        }.value

        do {
            try await engine.callVoid("app.secrets", ["secrets": bundle])
            secretsUnlocked = true
        } catch {
            banner = Banner(
                level: .error,
                title: "Could not unlock stored credentials",
                detail: error.localizedDescription
            )
        }
        await refresh()
    }

    func refresh() async {
        do {
            let state: AppState = try await engine.call("app.state")
            account = state.account
            providers = state.providers
            repos = state.repos
            schedules = state.schedules
            githubClientId = state.settings.githubClientId ?? ""
            if selectedRepoID == nil { selectedRepoID = repos.first?.id }
            if let id = selectedRepoID, !repos.contains(where: { $0.id == id }) {
                selectedRepoID = repos.first?.id
            }
        } catch {
            banner = Banner(level: .error, title: "Could not read the engine's state", detail: error.localizedDescription)
        }
    }

    func shutdown() {
        engine.stop()
    }

    // MARK: - Events

    private func handle(_ event: EngineEvent) {
        // Deploy logs have their own window; they would drown the activity strip.
        if event.t == "deploy_log" { return }

        if let text = event.displayText {
            append(kind: event.t, repoId: event.repoId, text: text)
        } else {
            switch event.t {
            case "sync_done":
                append(kind: event.t, repoId: event.repoId,
                       text: event.changed == true ? "Synced — new code indexed" : "Already up to date")
            case "index_done":
                append(kind: event.t, repoId: event.repoId, text: "Index complete")
            case "watch_tick":
                if event.moved == true { append(kind: event.t, repoId: event.repoId, text: "The branch moved") }
            case "edges_verified":
                // Spelling out where the rest went, because "kept 0 of 17" on its
                // own reads like a failure when it usually means the static pass
                // already had them.
                var detail: [String] = []
                if let n = event.alreadyStatic, n > 0 { detail.append("\(n) already known from imports") }
                if let n = event.unprovenEvidence, n > 0 { detail.append("\(n) unproven") }
                if let n = event.unknownPath, n > 0 { detail.append("\(n) bad paths") }
                let suffix = detail.isEmpty ? "" : " — \(detail.joined(separator: ", "))"
                append(kind: event.t, repoId: event.repoId,
                       text: "Kept \(event.kept ?? 0) of \(event.proposed ?? 0) inferred edges\(suffix)")
            case "conflict_needs_review":
                append(kind: event.t, repoId: event.repoId, text: "Merge conflicts need review")
            default:
                break
            }
        }

        // Anything that can change a repo's row is worth a cheap refresh.
        switch event.t {
        case "repos_changed", "repo_status", "index_done", "sync_done", "deploy_state",
             "branch_changed", "account_changed", "providers_changed", "schedule_set":
            Task { await refresh() }
        default:
            break
        }
    }

    private func append(kind: String, repoId: Int?, text: String) {
        activity.append(ActivityLine(at: Date(), repoId: repoId, kind: kind, text: text))
        if activity.count > 400 { activity.removeFirst(activity.count - 400) }
    }

    func activity(for repoId: Int?) -> [ActivityLine] {
        guard let repoId else { return activity }
        return activity.filter { $0.repoId == repoId || $0.repoId == nil }
    }

    // MARK: - GitHub

    /// The three ways in, in the order they cost the user effort.
    func signInWithGitHubCLI() async throws {
        let result: TokenResult = try await engine.call("github.cliToken")
        try await store(token: result.token)
    }

    func startDeviceFlow() async throws -> DeviceCodeStart {
        guard !githubClientId.isEmpty else {
            throw EngineError(message: "Add an OAuth App client ID in Settings first — device sign-in needs one.")
        }
        return try await engine.call("github.deviceStart", ["clientId": githubClientId])
    }

    func pollDeviceFlow(deviceCode: String) async throws -> DevicePollResult {
        try await engine.call("github.devicePoll", ["clientId": githubClientId, "deviceCode": deviceCode])
    }

    func signIn(withToken token: String) async throws {
        try await store(token: token)
    }

    private func store(token: String) async throws {
        let ref = SecretStore.ref("github", "token")
        guard SecretStore.set(token, for: ref) else {
            throw EngineError(message: "The token could not be saved to the Keychain.")
        }
        try await engine.callVoid("app.secrets", ["secrets": [ref: token]])
        let me: Account = try await engine.call("github.connect", ["tokenRef": ref])
        account = me
        banner = Banner(level: .success, title: "Signed in as \(me.login)", detail: nil)
        await refresh()
    }

    func signOut() async {
        SecretStore.delete(SecretStore.ref("github", "token"))
        _ = try? await engine.call("github.signOut", as: JSONValue.self)
        account = nil
        remoteRepos = []
        await refresh()
    }

    func loadRemoteRepos() async {
        guard account != nil else { return }
        isLoadingRemoteRepos = true
        defer { isLoadingRemoteRepos = false }
        do {
            let result: GitHubRepoList = try await engine.call("github.repos", ["page": 1])
            remoteRepos = result.repos
        } catch {
            banner = Banner(level: .error, title: "Could not list your repositories", detail: error.localizedDescription)
        }
    }

    func saveGitHubClientID(_ value: String) async {
        githubClientId = value
        _ = try? await engine.call("app.setting", ["key": "github_client_id", "value": value], as: JSONValue.self)
    }

    // MARK: - Providers

    func saveProvider(
        id: Int?,
        label: String,
        kind: ProviderKind,
        baseURL: String,
        model: String,
        fastModel: String,
        apiKey: String?,
        effort: String,
        isDefault: Bool
    ) async throws {
        var keyRef: String?
        if kind.needsKey || !(apiKey ?? "").isEmpty {
            let ref = SecretStore.ref("provider", label.lowercased().replacingOccurrences(of: " ", with: "-"))
            if let apiKey, !apiKey.isEmpty {
                guard SecretStore.set(apiKey, for: ref) else {
                    throw EngineError(message: "The API key could not be saved to the Keychain.")
                }
                try await engine.callVoid("app.secrets", ["secrets": [ref: apiKey]])
            }
            keyRef = ref
        }

        var params: [String: Any] = [
            "label": label,
            "kind": kind.rawValue,
            "model": model,
            "effort": effort,
            "isDefault": isDefault,
        ]
        if let id { params["id"] = id }
        if !baseURL.isEmpty { params["baseUrl"] = baseURL }
        if !fastModel.isEmpty { params["fastModel"] = fastModel }
        if let keyRef { params["keyRef"] = keyRef }

        _ = try await engine.call("ai.save", params, as: JSONValue.self)
        await refresh()
    }

    func deleteProvider(_ provider: ProviderInfo) async {
        if let ref = provider.keyRef { SecretStore.delete(ref) }
        _ = try? await engine.call("ai.delete", ["id": provider.id], as: JSONValue.self)
        await refresh()
    }

    func testProvider(_ provider: ProviderInfo) async -> Result<PingResult, Error> {
        do {
            let result: PingResult = try await engine.call("ai.test", ["id": provider.id])
            return .success(result)
        } catch {
            return .failure(error)
        }
    }

    // MARK: - Repositories

    func inspect(url: String, credentialRef: String?) async throws -> RemoteInspection {
        var params: [String: Any] = ["url": url]
        if let credentialRef {
            params["credentialRef"] = credentialRef
            params["authType"] = url.hasPrefix("http") ? "token" : "ssh"
        }
        return try await engine.call("repo.inspect", params)
    }

    /// Add and immediately clone + index. The caller gets the id back so it can
    /// select the new repository while the first index is still running.
    @discardableResult
    func addRepo(_ params: [String: Any], setUp: Bool = true) async throws -> Int {
        let created: AddRepoResult = try await engine.call("repo.add", params)
        await refresh()
        selectedRepoID = created.repoId

        if setUp {
            Task {
                do {
                    _ = try await engine.call("repo.setup", ["repoId": created.repoId], as: IndexResult.self)
                } catch {
                    banner = Banner(level: .error, title: "Setup failed", detail: error.localizedDescription)
                }
                await refresh()
            }
        }
        return created.repoId
    }

    func updateRepo(_ repoId: Int, _ patch: [String: Any]) async {
        var params = patch
        params["repoId"] = repoId
        _ = try? await engine.call("repo.update", params, as: Repo.self)
        await refresh()
    }

    func removeRepo(_ repoId: Int, deleteFiles: Bool) async {
        _ = try? await engine.call(
            "repo.remove", ["repoId": repoId, "deleteFiles": deleteFiles], as: JSONValue.self
        )
        await refresh()
    }

    func setSchedule(repoId: Int, cron: String, timezone: String, watchPrs: Bool, watchMinutes: Int) async throws {
        _ = try await engine.call(
            "sched.set",
            [
                "repoId": repoId,
                "cron": cron,
                "timezone": timezone,
                "watchPrs": watchPrs,
                "watchIntervalMin": watchMinutes,
            ],
            as: JSONValue.self
        )
        await refresh()
    }

    func show(_ banner: Banner) {
        self.banner = banner
    }
}
