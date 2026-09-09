import Foundation

// Wire types for everything the engine returns.
//
// The engine speaks camelCase for values it composes itself and snake_case for
// rows it hands straight out of sqlite. Rather than force one convention on the
// other, the snake_case cases are spelled out in CodingKeys here — the mapping
// is written once, in the place that already has to know the shape.

// MARK: - Identity and providers

struct Account: Codable, Hashable {
    let login: String
    let name: String?
    let avatarUrl: String?
    let scopes: [String]
    let tokenRef: String?
    let unlocked: Bool?

    var displayName: String { name?.isEmpty == false ? name! : login }
    var canReadPrivate: Bool { scopes.contains("repo") }
}

struct DeviceCodeStart: Codable {
    let deviceCode: String
    let userCode: String
    let verificationUri: String
    let interval: Int
    let expiresIn: Int
}

struct DevicePollResult: Codable {
    let token: String?
    let pending: Bool?
    let slowDown: Bool?
    let interval: Int?
}

struct TokenResult: Codable {
    let token: String
}

enum ProviderKind: String, Codable, CaseIterable, Identifiable {
    case anthropic
    case openai
    case compatible

    var id: String { rawValue }

    var label: String {
        switch self {
        case .anthropic: return "Claude (Anthropic)"
        case .openai: return "OpenAI"
        case .compatible: return "OpenAI-compatible endpoint"
        }
    }

    var blurb: String {
        switch self {
        case .anthropic: return "An Anthropic API key. Best results for the knowledge graph."
        case .openai: return "An OpenAI API key."
        case .compatible: return "Anything that speaks the OpenAI API — Ollama, LM Studio, vLLM, OpenRouter, Azure."
        }
    }

    var defaultModel: String {
        switch self {
        case .anthropic: return "claude-opus-5"
        case .openai: return "gpt-5.5"
        case .compatible: return "qwen2.5-coder:14b"
        }
    }

    var defaultFastModel: String {
        switch self {
        case .anthropic: return "claude-haiku-4-5"
        case .openai: return "gpt-5.4-mini"
        case .compatible: return ""
        }
    }

    var needsBaseURL: Bool { self == .compatible }
    var needsKey: Bool { self != .compatible }
}

struct ProviderInfo: Codable, Identifiable, Hashable {
    let id: Int
    let label: String
    let kind: String
    let baseUrl: String?
    let model: String
    let fastModel: String?
    let effort: String
    let maxTokens: Int
    let isDefault: Bool
    let keyRef: String?
    let unlocked: Bool

    var kindValue: ProviderKind { ProviderKind(rawValue: kind) ?? .compatible }
}

struct PingResult: Codable {
    let ok: Bool
    let model: String
    let latencyMs: Int
}

// MARK: - Repositories

struct RepoCounts: Codable, Hashable {
    let files: Int
    let openPrs: Int
}

struct DeployProfile: Codable, Hashable {
    var kind: String
    var label: String
    var install: String
    var run: String
    var stop: String
    var port: Int?
    var detectedFrom: String?
    var cwd: String?
    var envFile: String?
    var envExample: String?
    var envMissing: Bool?
    var healthUrl: String?
    var healthTimeoutSec: Int?

    var asDictionary: [String: Any] {
        var out: [String: Any] = [
            "kind": kind,
            "label": label,
            "install": install,
            "run": run,
            "stop": stop,
            "cwd": cwd ?? ".",
            "healthUrl": healthUrl ?? "",
            "healthTimeoutSec": healthTimeoutSec ?? 120,
            "envMissing": envMissing ?? false,
        ]
        if let port { out["port"] = port }
        if let detectedFrom { out["detectedFrom"] = detectedFrom }
        if let envFile { out["envFile"] = envFile }
        if let envExample { out["envExample"] = envExample }
        return out
    }
}

struct Repo: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let url: String
    let host: String?
    let owner: String?
    let authType: String
    let credentialRef: String?
    let branch: String
    let branchAuto: Bool
    let providerId: Int?
    let status: String
    let statusDetail: String?
    let progress: String?
    let insight: String?
    let lastIndexedSha: String?
    let lastIndexedAt: String?
    let lastPulledAt: String?
    let cron: String?
    let timezone: String?
    let watchPrs: Bool
    let watchIntervalMin: Int
    let lastWatchAt: String?
    let pullStrategy: String
    let aiConflictFix: Bool
    let deployEnabled: Bool
    let autoDeploy: Bool
    let deployState: String
    let deployPid: Int?
    let deployProfile: DeployProfile?
    let kgBuiltAt: String?
    let createdAt: String?
    let counts: RepoCounts
    let cloned: Bool
    let workdir: String

    var isBusy: Bool { status == "cloning" || status == "indexing" }
    var hasKnowledge: Bool { kgBuiltAt != nil }
}

struct RepoListResult: Codable { let repos: [Repo] }

struct RemoteInspection: Codable {
    let host: String
    let owner: String
    let name: String
    let branches: [String]
    let suggested: String
    let `private`: Bool?
    let description: String?
    let language: String?
    let via: String
}

struct AddRepoResult: Codable { let repoId: Int }

struct GitHubRepo: Codable, Identifiable, Hashable {
    let fullName: String
    let owner: String?
    let name: String
    let `private`: Bool
    let defaultBranch: String?
    let sshUrl: String?
    let httpsUrl: String?
    let description: String?
    let language: String?
    let pushedAt: String?
    let stars: Int?

    var id: String { fullName }
}

struct GitHubRepoList: Codable { let repos: [GitHubRepo] }

struct WorktreeStatus: Codable {
    let cloned: Bool
    let indexing: Bool?
    let branch: String?
    let dirty: Bool?
    let ahead: Int?
    let behind: Int?
    let clean: Bool?
    let dirtyFiles: [DirtyFile]?

    struct DirtyFile: Codable, Hashable {
        let code: String
        let path: String
    }
}

struct PullResult: Codable {
    let ok: Bool
    let strategy: String
    let conflicts: [String]
    let from: String?
    let to: String?
    let changed: Bool?
}

struct IndexResult: Codable {
    let sha: String?
    let files: Int?
    let commits: Int?
    let previousSha: String?
    let providerError: String?
    let upToDate: Bool?
    let blocked: Bool?
    let conflicts: [String]?
}

struct JobInfo: Codable, Identifiable, Hashable {
    let id: Int
    let type: String
    let status: String
    let message: String?
    let startedAt: String
    let finishedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, type, status, message
        case startedAt = "started_at"
        case finishedAt = "finished_at"
    }
}

struct JobList: Codable { let jobs: [JobInfo] }

struct PullRequestInfo: Codable, Identifiable, Hashable {
    let number: Int
    let title: String?
    let author: String?
    let state: String?
    let baseBranch: String?
    let headBranch: String?
    let url: String?
    let updatedAt: String?
    let mergedAt: String?
    let ingested: Int?

    var id: Int { number }

    enum CodingKeys: String, CodingKey {
        case number, title, author, state, url, ingested
        case baseBranch = "base_branch"
        case headBranch = "head_branch"
        case updatedAt = "updated_at"
        case mergedAt = "merged_at"
    }
}

struct PullRequestList: Codable { let pullRequests: [PullRequestInfo] }

// MARK: - Graph

struct GraphNode: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let path: String
    let layer: String
    let module: String?
    let cluster: Int
    let role: String?
    let summary: String?
    let loc: Int
    let heat: Double
    let churn: Int
    let merges: Int
    let degree: Int
    let fileCount: Int?
    let files: [String]?
    let folder: String?
    let lastChangeAt: String?

    // Present only in the function-level view.
    let line: Int?
    let symbolKind: String?
    let signature: String?
    let exported: Bool?
    let inDegree: Int?
    let outDegree: Int?

    /// Where this node sits in a request's journey, used by the flow layout.
    /// Left to right: what the user touches, what receives it, what guards it,
    /// what orchestrates it, what does the work, what stores it.
    var flowRank: Int {
        switch symbolKind {
        case "handler": return 1
        case "component", "hook": return 0
        default: break
        }
        switch layer {
        case "page", "component": return 0
        case "route": return 1
        case "middleware": return 2
        case "controller": return 3
        case "service", "engine": return 4
        case "model": return 5
        default: return 6
        }
    }

    var location: String {
        guard let line, line > 0 else { return path }
        return "\(path):\(line)"
    }
}

struct GraphEdge: Codable, Hashable {
    let from: String
    let to: String
    /// The line the call appears on, in the source file — function view only.
    let line: Int?
    /// The most specific relationship between this pair.
    let kind: String
    /// Every relationship between the pair. A file can both import another and
    /// call a named function on it; the canvas draws one line, the tooltip says
    /// both things.
    let kinds: [String]?
    let inferred: Bool
    let weight: Double
    let how: String?
    let evidence: String?

    var isSemantic: Bool { kind != "import" }
    var relationshipSummary: String { (kinds ?? [kind]).joined(separator: " + ") }
}

struct GraphRepoMeta: Codable, Hashable {
    let name: String
    let defaultBranch: String
    let lastIndexedAt: String?
    let lastIndexedSha: String?
    let insight: String?

    enum CodingKeys: String, CodingKey {
        case name
        case defaultBranch = "default_branch"
        case lastIndexedAt = "last_indexed_at"
        case lastIndexedSha = "last_indexed_sha"
        case insight
    }
}

struct LayerCount: Codable, Hashable { let layer: String; let count: Int }
struct ModuleCount: Codable, Hashable { let module: String; let n: Int }
struct ClusterCount: Codable, Hashable { let cluster: Int; let n: Int }

struct GraphMeta: Codable, Hashable {
    let repo: GraphRepoMeta?
    let visibleFiles: Int
    let layers: [LayerCount]
    let modules: [ModuleCount]
    let clusters: [ClusterCount]
    let edgeCount: Int
}

struct GraphData: Codable {
    let grouping: String
    let nodes: [GraphNode]
    let edges: [GraphEdge]
    let meta: GraphMeta

    static let empty = GraphData(
        grouping: "file",
        nodes: [],
        edges: [],
        meta: GraphMeta(repo: nil, visibleFiles: 0, layers: [], modules: [], clusters: [], edgeCount: 0)
    )
}

struct Hotspot: Codable, Identifiable, Hashable {
    let path: String
    let layer: String
    let module: String?
    let role: String?
    let summary: String?
    let loc: Int
    let heat: Double
    let churn: Int
    let merges: Int
    let degree: Int
    let lastChangeAt: String?

    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case path, layer, module, role, summary, loc, heat, churn, merges, degree
        case lastChangeAt = "last_change_at"
    }
}

struct HotspotList: Codable { let files: [Hotspot] }

struct CommitInfo: Codable, Identifiable, Hashable {
    let sha: String
    let shortSha: String
    let author: String?
    let message: String?
    let committedAt: String
    let isMerge: Int
    let prNumber: String?
    let files: Int
    let churn: Int

    var id: String { sha }

    enum CodingKeys: String, CodingKey {
        case sha, author, message, files, churn
        case shortSha = "short_sha"
        case committedAt = "committed_at"
        case isMerge = "is_merge"
        case prNumber = "pr_number"
    }
}

struct CommitList: Codable { let commits: [CommitInfo] }

struct ActivityWeek: Codable, Identifiable, Hashable {
    let week: String
    let merges: Int
    let churn: Int
    var id: String { week }
}

struct ActivityResult: Codable { let weeks: [ActivityWeek] }

struct FileRow: Codable, Hashable {
    let path: String
    let ext: String
    let loc: Int
    let layer: String
    let role: String?
    let summary: String?
    let module: String?
    let exports: [String]?
    let heat: Double
    let churn: Int
    let commitCount: Int
    let degree: Int
    let community: Int
    let lastChangeAt: String?

    enum CodingKeys: String, CodingKey {
        case path, ext, loc, layer, role, summary, module, exports, heat, churn, degree, community
        case commitCount = "commit_count"
        case lastChangeAt = "last_change_at"
    }
}

struct Neighbour: Codable, Hashable {
    let path: String
    let layer: String
    let module: String?
    let kind: String
    let inferred: Bool
    let evidence: String?
}

struct FileHistoryEntry: Codable, Hashable, Identifiable {
    let sha: String
    let message: String?
    let author: String?
    let date: String
    let prNumber: String?
    let additions: Int
    let deletions: Int

    var id: String { sha + date }

    enum CodingKeys: String, CodingKey {
        case sha, message, author, date, additions, deletions
        case prNumber = "pr_number"
    }
}

struct EndpointRef: Codable, Hashable {
    let method: String
    let path: String
    let summary: String?
    let auth: String?
}

struct FileDetail: Codable {
    let file: FileRow
    let dependsOn: [Neighbour]
    let usedBy: [Neighbour]
    let history: [FileHistoryEntry]
    let endpoints: [EndpointRef]
}

struct SymbolRow: Codable, Hashable {
    let path: String
    let name: String
    let kind: String
    let line: Int
    let signature: String?
    let params: String?
    let exported: Bool
    let layer: String?
    let module: String?
    let purpose: String?
    let returns: String?
    let sideEffects: [String]?
    let throws_: [String]?
    let inDegree: Int
    let outDegree: Int

    enum CodingKeys: String, CodingKey {
        case path, name, kind, line, signature, params, exported, layer, module, purpose, returns
        case sideEffects
        case throws_ = "throws"
        case inDegree = "in_degree"
        case outDegree = "out_degree"
    }
}

struct SymbolLink: Codable, Hashable, Identifiable {
    let name: String
    let path: String
    let kind: String
    let line: Int
    let edgeKind: String
    let callLine: Int
    let evidence: String?

    var id: String { "\(path)::\(name)::\(callLine)" }
    var location: String { "\(path):\(line)" }
}

struct SymbolDetail: Codable {
    let symbol: SymbolRow
    let calls: [SymbolLink]
    let calledBy: [SymbolLink]
}

// MARK: - Knowledge graph

struct KGField: Codable, Hashable, Identifiable {
    let name: String
    let type: String
    let required: Bool
    let note: String?
    var id: String { name }
}

struct KGRequest: Codable, Hashable {
    let pathParams: [KGField]?
    let queryParams: [KGField]?
    let bodyFields: [KGField]?
}

struct KGResponse: Codable, Hashable {
    let success: String?
    let errors: [String]?
}

struct KGEndpoint: Codable, Hashable, Identifiable {
    let method: String
    let path: String
    let handler: String?
    let symbol: String?
    let module: String?
    let auth: String?
    let middleware: [String]
    let request: KGRequest
    let response: KGResponse
    let statusCodes: [String]
    let summary: String?
    let evidence: String?

    var id: String { "\(method) \(path)" }
}

struct KGRelation: Codable, Hashable {
    let to: String
    let kind: String
    let via: String?
}

struct KGEntity: Codable, Hashable, Identifiable {
    let name: String
    let filePath: String?
    let store: String?
    let fields: [KGField]
    let relations: [KGRelation]
    let summary: String?
    var id: String { name }
}

struct KGScreen: Codable, Hashable, Identifiable {
    let name: String
    let route: String?
    let filePath: String?
    let components: [String]
    let calls: [String]
    let summary: String?
    var id: String { name }
}

struct KGEnvVar: Codable, Hashable, Identifiable {
    let name: String
    let required: Bool
    let example: String?
    let usedIn: [String]
    let note: String?
    var id: String { name }
}

struct KGStackItem: Codable, Hashable, Identifiable {
    let name: String
    let role: String
    let version: String?
    var id: String { name }
}

struct KGEntryPoint: Codable, Hashable, Identifiable {
    let path: String
    let what: String
    var id: String { path }
}

struct KGCommands: Codable, Hashable {
    let install: String?
    let dev: String?
    let build: String?
    let test: String?
    let lint: String?
    let migrate: String?

    var pairs: [(String, String)] {
        [("install", install), ("dev", dev), ("build", build),
         ("test", test), ("lint", lint), ("migrate", migrate)]
            .compactMap { key, value in
                guard let value, !value.isEmpty else { return nil }
                return (key, value)
            }
    }
}

struct KGGlossaryItem: Codable, Hashable, Identifiable {
    let term: String
    let meaning: String
    var id: String { term }
}

struct KGOverview: Codable, Hashable {
    let purpose: String?
    let elevatorPitch: String?
    let stack: [KGStackItem]?
    let architecture: String?
    let entryPoints: [KGEntryPoint]?
    let commands: KGCommands?
    let conventions: [String]?
    let gotchas: [String]?
    let glossary: [KGGlossaryItem]?
}

struct KGKeyFile: Codable, Hashable, Identifiable {
    let path: String
    let why: String
    var id: String { path }
}

struct KGModule: Codable, Hashable, Identifiable {
    let key: String
    let title: String
    let updatedAt: String?
    let module: String?
    let fileCount: Int?
    let what: String?
    let responsibilities: [String]?
    let keyFiles: [KGKeyFile]?
    let dataIn: [String]?
    let dataOut: [String]?
    let extendHere: [String]?
    let risks: [String]?

    var id: String { key }
    var name: String { module ?? key }
}

struct KGChange: Codable, Hashable, Identifiable {
    let what: String
    let where_: String
    let why: String?
    let breaking: Bool

    var id: String { what + where_ }

    enum CodingKeys: String, CodingKey {
        case what
        case where_ = "where"
        case why, breaking
    }
}

struct KGChangelogCommit: Codable, Hashable, Identifiable {
    let sha: String
    let subject: String
    let date: String?
    var id: String { sha }
}

struct KGChangelog: Codable, Hashable, Identifiable {
    let key: String
    let title: String
    let updatedAt: String?
    let headline: String?
    let changes: [KGChange]?
    let affectedModules: [String]?
    let agentImpact: [String]?
    let commits: [KGChangelogCommit]?
    var id: String { key }
}

struct KGRepoInfo: Codable, Hashable {
    let name: String
    let url: String
    let branch: String
    let indexedSha: String?
    let indexedAt: String?
    let builtAt: String?
}

// ── the agent-facing depth ───────────────────────────────────────────────────

struct KGFlowStep: Codable, Hashable, Identifiable {
    let depth: Int
    let name: String
    let kind: String?
    let path: String
    let line: Int
    let callLine: Int
    let layer: String?
    let module: String?
    let evidence: String?
    let alsoCalls: [String]?

    var id: String { "\(path)::\(name)::\(callLine)" }
    var location: String { "\(path):\(line)" }
}

struct KGFlow: Codable, Hashable, Identifiable {
    let key: String
    let entryPath: String
    let entryLine: Int
    let module: String?
    let depth: Int
    let touches: [String]
    let steps: [KGFlowStep]

    var id: String { "\(key)@\(entryPath)" }
    var entryLocation: String { "\(entryPath):\(entryLine)" }
    var isEndpoint: Bool { key.contains(" /") }
}

struct KGError: Codable, Hashable, Identifiable {
    let kind: String
    let label: String
    let path: String
    let line: Int
    let symbol: String?
    let module: String?
    let evidence: String?
    let meaning: String?

    var id: String { "\(path):\(line):\(label)" }
    var location: String { "\(path):\(line)" }
}

struct KGTestFile: Codable, Hashable, Identifiable {
    let path: String
    let cases: [String]
    var id: String { path }
}

struct KGTestCoverage: Codable, Hashable, Identifiable {
    let path: String
    let tests: [KGTestFile]
    var id: String { path }
}

struct KGFunction: Codable, Hashable, Identifiable {
    let path: String
    let name: String
    let kind: String
    let line: Int
    let location: String
    let signature: String?
    let params: String?
    let exported: Bool
    let layer: String?
    let module: String?
    let purpose: String?
    let returns: String?
    let sideEffects: [String]
    let throws_: [String]
    let calledBy: Int
    let calls: Int

    var id: String { "\(path)::\(name)" }

    enum CodingKeys: String, CodingKey {
        case path, name, kind, line, location, signature, params, exported, layer, module
        case purpose, returns, sideEffects, calledBy, calls
        case throws_ = "throws"
    }
}

struct KGCheckFile: Codable, Hashable, Identifiable {
    let path: String
    let what: String
    var id: String { path }
}

struct KGPlaybookEntry: Codable, Hashable, Identifiable {
    let symptom: String
    let likelyCause: String
    let checkFirst: [KGCheckFile]
    let fixPattern: String?
    let verify: String?
    var id: String { symptom }
}

struct KGPlaybook: Codable, Hashable, Identifiable {
    let key: String
    let title: String
    let updatedAt: String?
    let module: String?
    let playbooks: [KGPlaybookEntry]?
    let invariants: [String]?

    var id: String { key }
    var name: String { module ?? key }
}

struct KnowledgeGraph: Codable {
    let repo: KGRepoInfo
    let overview: KGOverview?
    let modules: [KGModule]
    let changelog: [KGChangelog]
    let endpoints: [KGEndpoint]
    let entities: [KGEntity]
    let screens: [KGScreen]
    let env: [KGEnvVar]
    let hotspots: [Hotspot]

    // Present once the deep passes have run.
    let playbooks: [KGPlaybook]?
    let flows: [KGFlow]?
    let errors: [KGError]?
    let tests: [KGTestCoverage]?
    let functions: [KGFunction]?

    var isEmpty: Bool {
        overview == nil && modules.isEmpty && endpoints.isEmpty && entities.isEmpty && screens.isEmpty
    }

    var describedFunctions: [KGFunction] {
        (functions ?? []).filter { $0.purpose?.isEmpty == false }
    }
}

// MARK: - What landed

struct PRReviewFile: Codable, Hashable, Identifiable {
    let path: String
    let why: String
    var id: String { path }
}

struct PRSummary: Codable, Hashable, Identifiable {
    let id: Int
    let number: Int?
    let sha: String
    let shortSha: String
    let title: String?
    let author: String?
    let url: String?
    let mergedAt: String?
    let headline: String
    let overview: String?
    let features: [String]
    let fixes: [String]
    let refactors: [String]
    let breaking: [String]
    let reviewFiles: [PRReviewFile]
    let risk: String
    let riskReason: String?
    let commitCount: Int
    let filesChanged: Int
    let additions: Int
    let deletions: Int
    let createdAt: String?

    var label: String { number.map { "#\($0)" } ?? shortSha }
    var hasBreaking: Bool { !breaking.isEmpty }
}

struct PRSummaryList: Codable { let summaries: [PRSummary] }

struct ExportResult: Codable {
    let dest: String
    let files: Int
}

struct MarkdownResult: Codable { let markdown: String }

// MARK: - Deploy

struct DeployDetection: Codable {
    let profile: DeployProfile
    let candidates: [DeployProfile]
    let dir: String
}

struct DeployStatus: Codable {
    let state: String
    let pid: Int?
    let startedAt: String?
    let enabled: Bool
    let autoDeploy: Bool
    let supervised: Bool
    let profile: DeployProfile?
}

struct DeployStartResult: Codable {
    let ok: Bool
    let pid: Int?
    let port: Int?
    let healthy: Bool?
    let reason: String?
}

struct LogLine: Codable, Hashable, Identifiable {
    let stream: String
    let text: String
    let at: Double?

    var id: String { "\(at ?? 0)-\(text)" }
}

struct LogResult: Codable { let lines: [LogLine] }

// MARK: - Conflicts

struct ConflictSides: Codable, Hashable {
    let path: String
    let base: String
    let ours: String
    let theirs: String
    let merged: String
}

struct ConflictResolution: Codable, Identifiable, Hashable {
    let path: String
    let status: String
    let reason: String?
    let merged: String?
    let rationale: String?
    let confidence: String?
    let keptFromOurs: [String]?
    let keptFromTheirs: [String]?
    let concerns: [String]?
    let sides: ConflictSides?

    var id: String { path }
    var isProposed: Bool { status == "proposed" }
}

struct ConflictPreview: Codable {
    let conflicts: [String]
    let resolutions: [ConflictResolution]
}

// MARK: - Scheduling

struct ScheduleInfo: Codable, Identifiable, Hashable {
    let repoId: Int
    let name: String
    let cron: String?
    let timezone: String?
    let watching: Bool
    let watchMinutes: Int?
    let lastWatchAt: String?
    let lastIndexedAt: String?
    let status: String
    let cronActive: Bool
    let watcherActive: Bool

    var id: Int { repoId }
}

struct AppSettings: Codable, Hashable {
    let githubClientId: String?
}

struct AppState: Codable {
    let account: Account?
    let providers: [ProviderInfo]
    let repos: [Repo]
    let schedules: [ScheduleInfo]
    let settings: AppSettings
}
