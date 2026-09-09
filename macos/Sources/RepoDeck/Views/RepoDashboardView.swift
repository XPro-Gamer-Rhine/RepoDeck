import SwiftUI

/// One repository's dashboard.
///
/// The header is always visible because it answers the questions you have every
/// time you look at this window: is it current, is it running, and is anything
/// blocked. The tabs below are the detail.
struct RepoDashboardView: View {
    let repo: Repo
    @EnvironmentObject private var app: AppModel
    @StateObject private var detail: RepoDetail
    // REPODECK_TAB opens straight onto a tab — useful when checking a screen
    // repeatedly during development without clicking through to it each time.
    @State private var tab: Tab =
        Tab(rawValue: ProcessInfo.processInfo.environment["REPODECK_TAB"] ?? "") ?? .overview

    init(repo: Repo, app: AppModel) {
        self.repo = repo
        // Created here rather than in the parent so switching repositories
        // genuinely drops the previous graph instead of keeping every one alive.
        _detail = StateObject(wrappedValue: RepoDetail(repoId: repo.id, app: app))
    }

    enum Tab: String, CaseIterable, Identifiable {
        case overview, graph, knowledge, deploy, history, settings
        var id: String { rawValue }

        var label: String {
            switch self {
            case .overview: return "Overview"
            case .graph: return "Graph"
            case .knowledge: return "Knowledge"
            case .deploy: return "Deploy"
            case .history: return "History"
            case .settings: return "Settings"
            }
        }

        var icon: String {
            switch self {
            case .overview: return "square.grid.2x2"
            case .graph: return "point.3.connected.trianglepath.dotted"
            case .knowledge: return "book.closed"
            case .deploy: return "play.rectangle"
            case .history: return "clock"
            case .settings: return "slider.horizontal.3"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Picker("", selection: $tab) {
                ForEach(Tab.allCases) { t in
                    Label(t.label, systemImage: t.icon).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()

            content
        }
        // Each tab loads its own data in its own `.task`. Driving it from
        // `onChange(of: tab)` looked equivalent but was not: the change handler
        // never fires for whichever tab is showing first, so a restored — or
        // deep-linked — tab came up permanently empty.
        .task { await detail.loadEverything() }
    }

    @ViewBuilder private var content: some View {
        switch tab {
        case .overview: OverviewTab(repo: repo, detail: detail)
        case .graph: graphTab
        case .knowledge: KnowledgeTab(repo: repo, detail: detail)
        case .deploy: DeployTab(repo: repo, detail: detail)
        case .history: HistoryTab(repo: repo, detail: detail)
        case .settings: RepoSettingsTab(repo: repo, detail: detail)
        }
    }

    private var graphTab: some View {
        HSplitView {
            GraphCanvasView(detail: detail)
                .frame(minWidth: 480)
            if detail.selectedNode != nil {
                NodeInspector(detail: detail)
                    .frame(width: 320)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(repo.name).font(.title2).bold()
                        StatusDot(status: repo.status, deployState: repo.deployState)
                        if repo.branchAuto {
                            Label(repo.branch, systemImage: "arrow.triangle.branch")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .help("Following the remote's own default branch")
                        } else {
                            Label(repo.branch, systemImage: "pin")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .help("Pinned manually")
                        }
                    }
                    Text(repo.url)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }

                Spacer()

                actions
            }

            if repo.isBusy, let progress = repo.progress, !progress.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(progress).font(.caption).foregroundStyle(.secondary)
                }
            }

            if repo.status == "error", let message = repo.statusDetail {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(message).font(.caption)
                    if message.lowercased().contains("conflict") {
                        Button("Resolve") { tab = .settings }
                            .buttonStyle(.link)
                    }
                }
            }

            stats
        }
        .padding(14)
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button {
                Task { await detail.pull() }
            } label: {
                Label("Pull", systemImage: "arrow.down")
            }
            .help("Fetch, then bring the working tree to the remote")
            .disabled(detail.isWorking || repo.isBusy)

            Button {
                Task { await detail.syncNow() }
            } label: {
                Label("Sync", systemImage: "arrow.triangle.2.circlepath")
            }
            .help("Pull, re-index what changed, refresh the knowledge graph, redeploy if that is turned on")
            .disabled(detail.isWorking || repo.isBusy)

            Menu {
                Button("Full re-index") { Task { await detail.index(full: true) } }
                Button("Check for new merges now") { Task { await detail.checkForWork() } }
                Divider()
                Button("Rebuild the knowledge graph") { Task { await detail.buildKnowledge() } }
                Button("Export knowledge bundle…") { exportBundle() }
                Divider()
                Button("Reveal the clone in Finder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: repo.workdir)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .frame(width: 30)

            if detail.isWorking {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var stats: some View {
        HStack(spacing: 18) {
            StatTile(value: "\(repo.counts.files)", label: "files indexed", systemImage: "doc.text")
            StatTile(value: "\(detail.graph.meta.edgeCount)", label: "connections", systemImage: "arrow.triangle.branch")
            StatTile(
                value: Timestamps.relative(repo.lastIndexedAt),
                label: "last indexed",
                tint: repo.lastIndexedAt == nil ? .orange : .secondary,
                systemImage: "clock"
            )
            StatTile(
                value: repo.counts.openPrs == 0 ? "—" : "\(repo.counts.openPrs)",
                label: "open PRs",
                systemImage: "arrow.triangle.pull"
            )
            StatTile(
                value: deployLabel,
                label: "local app",
                tint: repo.deployState == "running" ? .green : (repo.deployState == "failed" ? .red : .secondary),
                systemImage: "play.circle"
            )
            StatTile(
                value: repo.hasKnowledge ? Timestamps.relative(repo.kgBuiltAt) : "not built",
                label: "knowledge graph",
                tint: repo.hasKnowledge ? .secondary : .orange,
                systemImage: "book.closed"
            )
        }
    }

    private var deployLabel: String {
        switch repo.deployState {
        case "running": return "running"
        case "starting": return "starting"
        case "failed": return "failed"
        default: return repo.deployEnabled ? "stopped" : "off"
        }
    }

    private func exportBundle() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Export here"
        panel.message = "Choose where to write the knowledge-graph bundle."
        guard panel.runModal() == .OK, let base = panel.url else { return }
        let dest = base.appendingPathComponent("\(repo.name)-knowledge-graph")
        Task {
            if let written = await detail.exportKnowledge(to: dest) {
                NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: written)
            }
        }
    }
}

// MARK: - Overview

struct OverviewTab: View {
    let repo: Repo
    @ObservedObject var detail: RepoDetail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let insight = repo.insight, !insight.isEmpty {
                    SectionCard(title: "Where the work is going", systemImage: "sparkles") {
                        Text(insight).font(.callout)
                    }
                }

                if detail.graph.meta.visibleFiles == 0 {
                    EmptyStateView(
                        title: "Not indexed yet",
                        message: "Run a full index to build the architecture graph and the knowledge graph.",
                        systemImage: "square.dashed",
                        actionTitle: "Index now",
                        action: { Task { await detail.index(full: true) } }
                    )
                    .frame(height: 260)
                }

                HStack(alignment: .top, spacing: 14) {
                    hotspotsCard.frame(maxWidth: .infinity)
                    VStack(spacing: 14) {
                        activityCard
                        modulesCard
                    }
                    .frame(maxWidth: .infinity)
                }

                if !detail.landed.isEmpty {
                    landedCard
                }

                if !detail.pullRequests.isEmpty {
                    pullRequestsCard
                }
            }
            .padding(14)
        }
    }

    private var hotspotsCard: some View {
        SectionCard(
            title: "Changes the most",
            subtitle: "time-decayed merge churn",
            systemImage: "flame"
        ) {
            if detail.hotspots.isEmpty {
                Text("No merge history indexed yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(spacing: 7) {
                    ForEach(detail.hotspots.prefix(14)) { file in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                LayerBadge(layer: file.layer)
                                Text(file.path)
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Spacer()
                                Text("\(file.merges)×")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .help("\(file.merges) merges touched this file, \(file.churn) lines changed")
                            }
                            HeatBar(value: file.heat)
                        }
                        .help(file.summary ?? file.role ?? file.path)
                    }
                }
            }
        }
    }

    private var activityCard: some View {
        SectionCard(title: "Merge activity", subtitle: "last 26 weeks", systemImage: "chart.xyaxis.line") {
            if detail.weeks.isEmpty {
                Text("No merges indexed yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                Sparkline(values: detail.weeks.map { Double($0.merges) })
                    .frame(height: 46)
                HStack {
                    Text("\(detail.weeks.reduce(0) { $0 + $1.merges }) merges")
                    Spacer()
                    Text("\(detail.weeks.reduce(0) { $0 + $1.churn }) lines")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var modulesCard: some View {
        SectionCard(title: "Feature modules", systemImage: "square.stack.3d.up") {
            if detail.graph.meta.modules.isEmpty {
                Text("Modules appear once an AI provider has mapped the repository.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                let total = max(1, detail.graph.meta.modules.reduce(0) { $0 + $1.n })
                VStack(spacing: 5) {
                    ForEach(detail.graph.meta.modules.prefix(12), id: \.module) { entry in
                        HStack(spacing: 8) {
                            Circle()
                                .fill(Color(hue: GraphPalette.hue(forKey: entry.module) / 360, saturation: 0.6, brightness: 0.75))
                                .frame(width: 8, height: 8)
                            Text(entry.module).font(.caption)
                            Spacer()
                            Text("\(entry.n)").font(.caption2).foregroundStyle(.secondary)
                            ProgressView(value: Double(entry.n), total: Double(total))
                                .frame(width: 70)
                        }
                    }
                }
            }
        }
    }

    /// What actually landed, in plain language.
    ///
    /// The point of this card is that nobody has to open a diff to know whether
    /// last night's merges matter to them.
    private var landedCard: some View {
        SectionCard(
            title: "What landed",
            subtitle: "written from the commits and the diff",
            systemImage: "shippingbox"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(detail.landed.prefix(6)) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 6) {
                            Text(item.label)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Text(item.headline).font(.callout).bold()
                            Spacer()
                            riskBadge(item.risk)
                        }

                        if let overview = item.overview, !overview.isEmpty {
                            Text(overview).font(.caption).foregroundStyle(.secondary)
                        }

                        if item.hasBreaking {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(item.breaking, id: \.self) { line in
                                    Label(line, systemImage: "exclamationmark.triangle.fill")
                                        .font(.caption2)
                                        .foregroundStyle(.orange)
                                }
                            }
                        }

                        changeList("New", item.features, symbol: "plus.circle", tint: .green)
                        changeList("Fixed", item.fixes, symbol: "wrench.and.screwdriver", tint: .blue)

                        if !item.reviewFiles.isEmpty {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("WORTH OPENING")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(.tertiary)
                                ForEach(item.reviewFiles) { file in
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(file.path).font(.system(.caption2, design: .monospaced))
                                        Text(file.why).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }

                        HStack(spacing: 10) {
                            Text("\(item.commitCount) commits")
                            Text("\(item.filesChanged) files")
                            Text("+\(item.additions) −\(item.deletions)")
                            if let author = item.author { Text(author) }
                            Text(Timestamps.relative(item.mergedAt))
                            if let url = item.url, let link = URL(string: url) {
                                Link("open", destination: link)
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    }
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 7))
                }
            }
        }
    }

    @ViewBuilder private func changeList(_ title: String, _ items: [String], symbol: String, tint: Color) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 1) {
                Text(title.uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                ForEach(items.prefix(6), id: \.self) { line in
                    Label(line, systemImage: symbol)
                        .font(.caption2)
                        .foregroundStyle(tint)
                }
            }
        }
    }

    private func riskBadge(_ risk: String) -> some View {
        let tint: Color = risk == "high" ? .red : (risk == "medium" ? .orange : .green)
        return Text(risk)
            .font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(tint.opacity(0.2), in: Capsule())
            .foregroundStyle(tint)
            .help(risk == "high" ? "Touches data, auth, migrations or deployment" : "Risk assessed from the diff")
    }

    private var pullRequestsCard: some View {
        SectionCard(title: "Pull requests", subtitle: "from GitHub", systemImage: "arrow.triangle.pull") {
            VStack(spacing: 6) {
                ForEach(detail.pullRequests.prefix(12)) { pr in
                    HStack(spacing: 8) {
                        Image(systemName: icon(for: pr.state))
                            .foregroundStyle(color(for: pr.state))
                            .font(.caption)
                        Text("#\(pr.number)").font(.caption2).foregroundStyle(.secondary)
                        Text(pr.title ?? "").font(.caption).lineLimit(1)
                        Spacer()
                        if let author = pr.author {
                            Text(author).font(.caption2).foregroundStyle(.tertiary)
                        }
                        Text(Timestamps.relative(pr.updatedAt)).font(.caption2).foregroundStyle(.tertiary)
                        if let url = pr.url, let link = URL(string: url) {
                            Link(destination: link) { Image(systemName: "arrow.up.right.square") }
                                .font(.caption2)
                        }
                    }
                }
            }
        }
    }

    private func icon(for state: String?) -> String {
        switch state {
        case "merged": return "arrow.triangle.merge"
        case "closed": return "xmark.circle"
        default: return "circle"
        }
    }

    private func color(for state: String?) -> Color {
        switch state {
        case "merged": return .purple
        case "closed": return .secondary
        default: return .green
        }
    }
}

// MARK: - Node inspector

struct NodeInspector: View {
    @ObservedObject var detail: RepoDetail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let node = detail.selectedNode {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            LayerBadge(layer: node.layer)
                            if let module = node.module { Text(module).font(.caption2).foregroundStyle(.secondary) }
                            Spacer()
                            Button {
                                Task { await detail.select(node: nil) }
                            } label: {
                                Image(systemName: "xmark")
                            }
                            .buttonStyle(.plain)
                        }
                        Text(node.path)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                        if let role = node.role { Text(role).font(.caption).foregroundStyle(.secondary) }
                        if let summary = node.summary { Text(summary).font(.caption) }
                    }

                    HStack {
                        StatTile(value: "\(node.merges)", label: "merges")
                        StatTile(value: "\(node.churn)", label: "lines")
                        StatTile(value: "\(node.loc)", label: "LOC")
                        StatTile(value: "\(node.degree)", label: "links")
                    }

                    if let files = node.files, !files.isEmpty {
                        SectionCard(title: "Contains", subtitle: "\(files.count) files") {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(files.prefix(40), id: \.self) { path in
                                    Text(path).font(.system(.caption2, design: .monospaced)).lineLimit(1)
                                }
                            }
                        }
                    }

                    if let symbol = detail.symbolDetail {
                        SectionCard(title: "Function", systemImage: "function") {
                            if let signature = symbol.symbol.signature {
                                Text(signature)
                                    .font(.system(.caption2, design: .monospaced))
                                    .textSelection(.enabled)
                                    .padding(6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 5))
                            }
                            HStack(spacing: 10) {
                                Text(symbol.symbol.kind).font(.caption2).foregroundStyle(.secondary)
                                if symbol.symbol.exported {
                                    Text("exported").font(.caption2).foregroundStyle(.green)
                                }
                                Spacer()
                                Text("\(symbol.symbol.path):\(symbol.symbol.line)")
                                    .font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .textSelection(.enabled)
                            }
                            if let purpose = symbol.symbol.purpose, !purpose.isEmpty {
                                Text(purpose).font(.caption)
                            }
                        }
                        symbolLinks("Calls", symbol.calls)
                        symbolLinks("Called by", symbol.calledBy)
                    }

                    if let fileDetail = detail.fileDetail {
                        if !fileDetail.endpoints.isEmpty {
                            SectionCard(title: "Serves", systemImage: "network") {
                                ForEach(fileDetail.endpoints, id: \.self) { endpoint in
                                    HStack {
                                        Text(endpoint.method).font(.system(.caption2, design: .monospaced)).bold()
                                        Text(endpoint.path).font(.system(.caption2, design: .monospaced))
                                    }
                                }
                            }
                        }
                        neighbours("Depends on", fileDetail.dependsOn)
                        neighbours("Used by", fileDetail.usedBy)
                        if !fileDetail.history.isEmpty {
                            SectionCard(title: "Recent changes", systemImage: "clock") {
                                ForEach(fileDetail.history.prefix(10)) { entry in
                                    HStack(alignment: .top, spacing: 6) {
                                        Text(entry.sha).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(entry.message ?? "").font(.caption2).lineLimit(2)
                                            Text("+\(entry.additions) −\(entry.deletions) · \(Timestamps.relative(entry.date))")
                                                .font(.caption2)
                                                .foregroundStyle(.tertiary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(12)
        }
    }

    /// A call, with the line it happens on — the thing that makes the graph
    /// actionable rather than decorative.
    @ViewBuilder private func symbolLinks(_ title: String, _ items: [SymbolLink]) -> some View {
        if !items.isEmpty {
            SectionCard(title: title, subtitle: "\(items.count)") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items.prefix(25)) { item in
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 5) {
                                Image(systemName: item.edgeKind == "renders" ? "rectangle.on.rectangle" : "arrow.right")
                                    .font(.system(size: 8))
                                    .foregroundStyle(.tertiary)
                                Text(item.name).font(.system(.caption2, design: .monospaced))
                                Spacer()
                                Text("line \(item.callLine)").font(.system(size: 9)).foregroundStyle(.tertiary)
                            }
                            Text(item.location)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        .help(item.evidence ?? item.location)
                    }
                }
            }
        }
    }

    @ViewBuilder private func neighbours(_ title: String, _ items: [Neighbour]) -> some View {
        if !items.isEmpty {
            SectionCard(title: title, subtitle: "\(items.count)") {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(items.prefix(25), id: \.self) { item in
                        HStack(spacing: 5) {
                            Circle()
                                .fill(GraphPalette.color(for: item.layer))
                                .frame(width: 6, height: 6)
                            Text(item.path)
                                .font(.system(.caption2, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.head)
                            if item.kind != "import" {
                                Text(EdgeVocabulary.label(item.kind))
                                    .font(.system(size: 8))
                                    .padding(.horizontal, 4)
                                    .background(.tint.opacity(0.18), in: Capsule())
                            }
                            if item.inferred {
                                Image(systemName: "sparkle")
                                    .font(.system(size: 7))
                                    .foregroundStyle(.tertiary)
                                    .help(item.evidence.map { "Proven by: \($0)" } ?? "Inferred by the model")
                            }
                        }
                    }
                }
            }
        }
    }
}
