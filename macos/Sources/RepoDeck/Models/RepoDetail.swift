import Foundation
import SwiftUI

/// Everything one repository's dashboard needs, loaded lazily per tab.
///
/// One of these exists per selected repository. It is rebuilt on selection
/// rather than cached forever, because a graph for a 3,000-file repo is not
/// something to hold five copies of.
@MainActor
final class RepoDetail: ObservableObject {
    let repoId: Int
    let engine: EngineClient
    private unowned let app: AppModel

    @Published var graph: GraphData = .empty
    @Published var hotspots: [Hotspot] = []
    @Published var commits: [CommitInfo] = []
    @Published var weeks: [ActivityWeek] = []
    @Published var knowledge: KnowledgeGraph?
    @Published var pullRequests: [PullRequestInfo] = []
    @Published var landed: [PRSummary] = []
    @Published var jobs: [JobInfo] = []
    @Published var deployStatus: DeployStatus?
    @Published var deployLogs: [LogLine] = []
    @Published var worktree: WorktreeStatus?
    @Published var conflicts: ConflictPreview?

    @Published var isLoadingGraph = false
    @Published var isLoadingKnowledge = false
    @Published var isWorking = false
    @Published var workingLabel = ""
    @Published var errorText: String?

    // Graph controls, owned here so switching tabs does not reset them.
    // REPODECK_GRAPH / REPODECK_LAYOUT open the graph straight into a given view,
    // the same dev affordance as REPODECK_TAB.
    @Published var grouping = ProcessInfo.processInfo.environment["REPODECK_GRAPH"] ?? "auto" {
        didSet { Task { await loadGraph() } }
    }
    @Published var hideTests = true { didSet { Task { await loadGraph() } } }
    // Dragging the slider fires this continuously. Each tick was a full graph
    // round trip, and responses could land out of order — so releasing the slider
    // sometimes left the graph showing a threshold from halfway through the drag.
    @Published var minHeat: Double = 0 { didSet { scheduleGraphReload() } }
    private var graphReloadTask: Task<Void, Never>?

    private func scheduleGraphReload() {
        graphReloadTask?.cancel()
        graphReloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 180_000_000)
            guard !Task.isCancelled else { return }
            await self?.loadGraph()
        }
    }
    @Published var colourBy: ColourMode = .layer
    @Published var hiddenLayers: Set<String> = []
    @Published var selectedNode: GraphNode?
    @Published var fileDetail: FileDetail?
    @Published var symbolDetail: SymbolDetail?

    enum ColourMode: String, CaseIterable, Identifiable {
        case layer, folder, feature, cluster
        var id: String { rawValue }
        var label: String {
            switch self {
            case .layer: return "Layer"
            case .folder: return "Folder"
            case .feature: return "Feature"
            case .cluster: return "Cluster"
            }
        }
    }

    init(repoId: Int, app: AppModel) {
        self.repoId = repoId
        self.app = app
        self.engine = app.engine
    }

    // MARK: - Loading

    func loadEverything() async {
        async let g: Void = loadGraph()
        async let h: Void = loadHotspots()
        async let c: Void = loadCommits()
        async let a: Void = loadActivity()
        async let p: Void = loadPullRequests()
        async let j: Void = loadJobs()
        async let d: Void = loadDeployStatus()
        _ = await (g, h, c, a, p, j, d)
    }

    private var graphRequestSeq = 0

    func loadGraph() async {
        graphRequestSeq += 1
        let seq = graphRequestSeq
        isLoadingGraph = true
        defer { if seq == graphRequestSeq { isLoadingGraph = false } }

        var params: [String: Any] = [
            "repoId": repoId,
            "hideTests": hideTests,
            "minHeat": minHeat,
        ]
        if grouping != "auto" { params["nodes"] = grouping }
        do {
            let result: GraphData = try await engine.call("graph.get", params)
            // Last request wins, not last response. Two graph loads in flight can
            // finish out of order, and the older one would overwrite the newer.
            guard seq == graphRequestSeq else { return }
            graph = result
        } catch {
            guard seq == graphRequestSeq else { return }
            errorText = error.localizedDescription
        }
    }

    func loadHotspots() async {
        if let result: HotspotList = try? await engine.call("graph.hotspots", ["repoId": repoId, "limit": 100]) {
            hotspots = result.files
        }
    }

    func loadCommits() async {
        if let result: CommitList = try? await engine.call("graph.commits", ["repoId": repoId, "limit": 80]) {
            commits = result.commits
        }
    }

    func loadActivity() async {
        if let result: ActivityResult = try? await engine.call("graph.activity", ["repoId": repoId, "weeks": 26]) {
            weeks = result.weeks
        }
    }

    func loadKnowledge() async {
        isLoadingKnowledge = true
        defer { isLoadingKnowledge = false }
        do {
            knowledge = try await engine.call("kg.get", ["repoId": repoId], as: KnowledgeGraph.self)
        } catch {
            // `try?` here would render "no knowledge graph yet" over a graph that
            // exists — a decoding mismatch looking exactly like missing data.
            // Whatever went wrong, say so.
            knowledge = nil
            errorText = error.localizedDescription
            app.show(.init(
                level: .error,
                title: "Could not read the knowledge graph",
                detail: error.localizedDescription
            ))
        }
    }

    func loadPullRequests() async {
        if let result: PullRequestList = try? await engine.call("prs.list", ["repoId": repoId]) {
            pullRequests = result.pullRequests
        }
        if let result: PRSummaryList = try? await engine.call("prs.summaries", ["repoId": repoId, "limit": 30]) {
            landed = result.summaries
        }
    }

    /// Describe merges that landed before digests existed, or that a failed run skipped.
    func backfillDigests(limit: Int = 5) async {
        await run("Summarise recent merges") { [self] in
            _ = try await engine.call("prs.backfill", ["repoId": repoId, "limit": limit], as: JSONValue.self)
            await loadPullRequests()
        }
    }

    func loadJobs() async {
        if let result: JobList = try? await engine.call("repo.jobs", ["repoId": repoId, "limit": 40]) {
            jobs = result.jobs
        }
    }

    func loadDeployStatus() async {
        deployStatus = try? await engine.call("deploy.status", ["repoId": repoId], as: DeployStatus.self)
    }

    func loadDeployLogs() async {
        if let result: LogResult = try? await engine.call("deploy.logs", ["repoId": repoId, "tail": 500]) {
            deployLogs = result.lines
        }
    }

    func loadWorktree() async {
        worktree = try? await engine.call("repo.status", ["repoId": repoId], as: WorktreeStatus.self)
    }

    func select(node: GraphNode?) async {
        selectedNode = node
        fileDetail = nil
        symbolDetail = nil
        guard let node else { return }

        switch graph.grouping {
        case "file":
            fileDetail = try? await engine.call(
                "graph.file", ["repoId": repoId, "path": node.path], as: FileDetail.self
            )
        case "symbol":
            symbolDetail = try? await engine.call(
                "graph.symbol", ["repoId": repoId, "path": node.path, "name": node.label],
                as: SymbolDetail.self
            )
            // The owning file's history is what tells you whether this function
            // is in a part of the codebase that is currently moving.
            fileDetail = try? await engine.call(
                "graph.file", ["repoId": repoId, "path": node.path], as: FileDetail.self
            )
        default:
            break
        }
    }

    // MARK: - Actions

    private func run(_ label: String, _ body: @escaping () async throws -> Void) async {
        isWorking = true
        workingLabel = label
        errorText = nil
        defer {
            isWorking = false
            workingLabel = ""
        }
        do {
            try await body()
        } catch {
            errorText = error.localizedDescription
            app.show(.init(level: .error, title: label + " failed", detail: error.localizedDescription))
        }
        await app.refresh()
    }

    func pull() async {
        await run("Pull") { [self] in
            let result: PullResult = try await engine.call("repo.pull", ["repoId": repoId])
            if !result.ok {
                conflicts = ConflictPreview(conflicts: result.conflicts, resolutions: [])
                app.show(.init(
                    level: .warning,
                    title: "Merge conflict in \(result.conflicts.count) file(s)",
                    detail: "Open the Conflicts tab to resolve them."
                ))
            } else if result.changed == true {
                app.show(.init(level: .success, title: "Pulled new code", detail: nil))
            }
            await loadWorktree()
        }
    }

    func index(full: Bool) async {
        await run(full ? "Full re-index" : "Sync") { [self] in
            let result: IndexResult = try await engine.call(
                "repo.index", ["repoId": repoId, "full": full],
                onEvent: { _ in }
            )
            if result.blocked == true {
                conflicts = ConflictPreview(conflicts: result.conflicts ?? [], resolutions: [])
            }
            if let providerError = result.providerError {
                app.show(.init(level: .warning, title: "Indexed without AI", detail: providerError))
            }
            await loadEverything()
        }
    }

    func syncNow() async {
        await run("Sync") { [self] in
            _ = try await engine.call("sched.runNow", ["repoId": repoId], as: JSONValue.self)
            await loadEverything()
        }
    }

    func checkForWork() async {
        await run("Check for new merges") { [self] in
            _ = try await engine.call("sched.checkNow", ["repoId": repoId], as: JSONValue.self)
            await loadPullRequests()
        }
    }

    func buildKnowledge() async {
        await run("Build the knowledge graph") { [self] in
            _ = try await engine.call("kg.build", ["repoId": repoId], as: JSONValue.self)
            await loadKnowledge()
        }
    }

    func exportKnowledge(to destination: URL?) async -> String? {
        var params: [String: Any] = ["repoId": repoId]
        if let destination { params["dest"] = destination.path }
        do {
            let result: ExportResult = try await engine.call("kg.export", params)
            app.show(.init(level: .success, title: "Exported \(result.files) files", detail: result.dest))
            return result.dest
        } catch {
            app.show(.init(level: .error, title: "Export failed", detail: error.localizedDescription))
            return nil
        }
    }

    // MARK: - Conflicts

    func previewConflicts() async {
        await run("Resolve conflicts") { [self] in
            conflicts = try await engine.call("conflict.preview", ["repoId": repoId], as: ConflictPreview.self)
        }
    }

    func applyConflicts(_ resolutions: [ConflictResolution]) async {
        await run("Apply resolutions") { [self] in
            let payload = resolutions.compactMap { r -> [String: Any]? in
                guard let merged = r.merged else { return nil }
                return ["path": r.path, "contents": merged]
            }
            _ = try await engine.call(
                "conflict.apply", ["repoId": repoId, "resolutions": payload], as: JSONValue.self
            )
            conflicts = nil
            await loadWorktree()
        }
    }

    func takeSide(_ side: String) async {
        await run("Take \(side)") { [self] in
            _ = try await engine.call("conflict.takeSide", ["repoId": repoId, "side": side], as: JSONValue.self)
            conflicts = nil
            await loadWorktree()
        }
    }

    func stashAndReset() async {
        await run("Stash and reset") { [self] in
            _ = try await engine.call("conflict.stashAndReset", ["repoId": repoId], as: JSONValue.self)
            conflicts = nil
            await loadWorktree()
        }
    }

    // MARK: - Deploy

    func detectDeploy() async -> DeployDetection? {
        try? await engine.call("deploy.detect", ["repoId": repoId], as: DeployDetection.self)
    }

    func saveDeployProfile(_ profile: DeployProfile) async {
        await run("Save the run profile") { [self] in
            _ = try await engine.call(
                "deploy.save", ["repoId": repoId, "profile": profile.asDictionary], as: JSONValue.self
            )
            await loadDeployStatus()
        }
    }

    func startDeploy(install: Bool) async {
        await run("Start") { [self] in
            let result: DeployStartResult = try await engine.call(
                "deploy.start", ["repoId": repoId, "install": install],
                onEvent: { [weak self] event in
                    guard event.t == "deploy_log", let text = event.text else { return }
                    Task { @MainActor in
                        self?.deployLogs.append(LogLine(stream: event.stream ?? "stdout", text: text, at: nil))
                        if let count = self?.deployLogs.count, count > 800 {
                            self?.deployLogs.removeFirst(count - 800)
                        }
                    }
                }
            )
            if !result.ok {
                app.show(.init(level: .error, title: "The app did not come up", detail: result.reason))
            }
            await loadDeployStatus()
        }
    }

    func stopDeploy() async {
        await run("Stop") { [self] in
            _ = try await engine.call("deploy.stop", ["repoId": repoId], as: JSONValue.self)
            await loadDeployStatus()
        }
    }
}
