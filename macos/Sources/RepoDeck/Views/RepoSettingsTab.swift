import SwiftUI

/// Per-repository settings, plus the place conflicts get resolved.
///
/// Conflicts live here rather than in their own tab because they are a state
/// the repository is in, not a feature — and the settings that produced them
/// (pull strategy, AI resolution) are the things you want to reconsider while
/// looking at one.
struct RepoSettingsTab: View {
    let repo: Repo
    @ObservedObject var detail: RepoDetail
    @EnvironmentObject private var app: AppModel

    @State private var branch = ""
    @State private var branchAuto = true
    @State private var cron = "0 3 * * *"
    @State private var watchPrs = true
    @State private var watchMinutes = 60
    @State private var pullStrategy = "reset"
    @State private var aiConflictFix = false
    @State private var providerId: Int?
    @State private var branches: [String] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let conflicts = detail.conflicts, !conflicts.conflicts.isEmpty {
                    ConflictResolver(detail: detail, preview: conflicts)
                }

                worktreeCard
                branchCard
                scheduleCard
                pullCard
                analysisCard
                dangerCard
            }
            .padding(14)
        }
        .task {
            branch = repo.branch
            branchAuto = repo.branchAuto
            cron = repo.cron ?? "0 3 * * *"
            watchPrs = repo.watchPrs
            watchMinutes = repo.watchIntervalMin
            pullStrategy = repo.pullStrategy
            aiConflictFix = repo.aiConflictFix
            providerId = repo.providerId
            await detail.loadWorktree()
        }
    }

    // MARK: - Cards

    private var worktreeCard: some View {
        SectionCard(title: "Working tree", subtitle: repo.workdir, systemImage: "folder") {
            if let state = detail.worktree {
                if state.cloned {
                    HStack(spacing: 18) {
                        StatTile(value: state.branch ?? "—", label: "checked out")
                        StatTile(
                            value: "\(state.behind ?? 0)",
                            label: "behind origin",
                            tint: (state.behind ?? 0) > 0 ? .orange : .secondary
                        )
                        StatTile(
                            value: "\(state.ahead ?? 0)",
                            label: "local commits",
                            tint: (state.ahead ?? 0) > 0 ? .orange : .secondary
                        )
                        StatTile(
                            value: state.dirty == true ? "\(state.dirtyFiles?.count ?? 0) changed" : "clean",
                            label: "working tree",
                            tint: state.dirty == true ? .orange : .green
                        )
                        Spacer()
                        Button("Refresh") { Task { await detail.loadWorktree() } }
                    }

                    if state.clean == false {
                        Text("RepoDeck will merge rather than reset while this tree has work of its own in it, so nothing here gets thrown away.")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }

                    if let files = state.dirtyFiles, !files.isEmpty {
                        DisclosureGroup("\(files.count) modified files") {
                            ForEach(files, id: \.path) { file in
                                HStack(spacing: 6) {
                                    Text(file.code).font(.system(.caption2, design: .monospaced)).foregroundStyle(.orange)
                                    Text(file.path).font(.system(.caption2, design: .monospaced))
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .font(.caption)
                    }
                } else {
                    Text("Not cloned yet.").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var branchCard: some View {
        SectionCard(title: "Default branch", systemImage: "arrow.triangle.branch") {
            HStack {
                if branches.isEmpty {
                    TextField("branch", text: $branch)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 220)
                } else {
                    Picker("", selection: $branch) {
                        ForEach(branches, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                    .frame(width: 220)
                }

                Button("Load branches") {
                    Task {
                        if let inspection = try? await app.inspect(url: repo.url, credentialRef: repo.credentialRef) {
                            branches = inspection.branches
                            if branches.contains(inspection.suggested), branch.isEmpty { branch = inspection.suggested }
                        }
                    }
                }

                Spacer()
                Button("Apply") {
                    Task { await app.updateRepo(repo.id, ["branch": branch, "branchAuto": branchAuto]) }
                }
                .disabled(branch == repo.branch && branchAuto == repo.branchAuto)
            }

            Toggle("Let RepoDeck follow the remote's own default", isOn: $branchAuto)
                .toggleStyle(.checkbox)
            Text("With this on, each sync re-reads the remote HEAD first — so a team renaming `master` to `main` does not leave RepoDeck watching a branch that no longer moves.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var scheduleCard: some View {
        SectionCard(title: "Schedule", systemImage: "clock.arrow.2.circlepath") {
            HStack {
                Picker("Pull on a schedule", selection: $cron) {
                    Text("Every hour").tag("0 * * * *")
                    Text("Every 6 hours").tag("0 */6 * * *")
                    Text("Daily at 03:00").tag("0 3 * * *")
                    Text("Weekly (Monday 03:00)").tag("0 3 * * 1")
                    Text("Never").tag("off")
                }
                .frame(maxWidth: 320)
                Text(TimeZone.current.identifier).font(.caption2).foregroundStyle(.tertiary)
            }

            Toggle("Watch for merged pull requests", isOn: $watchPrs)
                .toggleStyle(.checkbox)
            if watchPrs {
                HStack {
                    Stepper("Check every \(watchMinutes) minutes", value: $watchMinutes, in: 5...720, step: 5)
                        .frame(maxWidth: 280)
                    Text("Last checked \(Timestamps.relative(repo.lastWatchAt))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Text("One API call per check — it asks GitHub whether the branch tip moved and lists pull requests. When a merge is found, RepoDeck fetches, updates, re-indexes what changed, refreshes the knowledge graph and redeploys if that is on.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("Apply") {
                    Task {
                        try? await app.setSchedule(
                            repoId: repo.id,
                            cron: cron,
                            timezone: TimeZone.current.identifier,
                            watchPrs: watchPrs,
                            watchMinutes: watchMinutes
                        )
                    }
                }
            }
        }
    }

    private var pullCard: some View {
        SectionCard(title: "Pulling and conflicts", systemImage: "arrow.down.circle") {
            Picker("", selection: $pullStrategy) {
                Text("Reset to origin — treat the clone as a mirror").tag("reset")
                Text("Merge — keep local commits").tag("merge")
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()

            Text("Every pull fetches first. Reset makes the tree match the remote exactly, which cannot conflict — and if the tree does contain local work, RepoDeck upgrades to a real merge instead of discarding it.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Let AI propose conflict resolutions", isOn: $aiConflictFix)
                .toggleStyle(.checkbox)
            if aiConflictFix {
                Text("Unattended runs apply a resolution only when the model is confident about every conflicted file. Anything less waits here, with its proposal and a three-way diff.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("Apply") {
                    Task {
                        await app.updateRepo(repo.id, ["pullStrategy": pullStrategy, "aiConflictFix": aiConflictFix])
                    }
                }
                .disabled(pullStrategy == repo.pullStrategy && aiConflictFix == repo.aiConflictFix)
            }
        }
    }

    private var analysisCard: some View {
        SectionCard(title: "Analysis model", systemImage: "sparkles") {
            if app.providers.isEmpty {
                Text("No AI provider is configured. Without one, RepoDeck still builds the file graph, the real import edges and the heatmap — but not roles, feature modules or the knowledge graph.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                SettingsLink { Text("Open Settings") }
            } else {
                Picker("Model", selection: $providerId) {
                    Text("Default (\(app.providers.first(where: { $0.isDefault })?.label ?? "none"))").tag(Int?.none)
                    ForEach(app.providers) { provider in
                        Text("\(provider.label) — \(provider.model)").tag(Int?.some(provider.id))
                    }
                }
                HStack {
                    Spacer()
                    Button("Apply") {
                        Task { await app.updateRepo(repo.id, ["providerId": providerId as Any]) }
                    }
                    .disabled(providerId == repo.providerId)
                }
            }
        }
    }

    private var dangerCard: some View {
        SectionCard(title: "Remove", systemImage: "trash") {
            Text("Removing drops the graph, the knowledge graph and the schedule. You can keep the clone on disk or delete it.")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button("Remove, keep the clone", role: .destructive) {
                    Task { await app.removeRepo(repo.id, deleteFiles: false) }
                }
                Button("Remove and delete the clone", role: .destructive) {
                    Task { await app.removeRepo(repo.id, deleteFiles: true) }
                }
            }
        }
    }
}

// MARK: - Conflict resolver

/// A merge stopped. This shows what the model would do about it, side by side
/// with what git actually has, and applies nothing until a person says so.
struct ConflictResolver: View {
    @ObservedObject var detail: RepoDetail
    let preview: ConflictPreview
    @State private var selected: String?

    var body: some View {
        SectionCard(
            title: "Merge conflict in \(preview.conflicts.count) file\(preview.conflicts.count == 1 ? "" : "s")",
            subtitle: preview.resolutions.isEmpty ? "not resolved yet" : nil,
            systemImage: "arrow.triangle.merge"
        ) {
            if preview.resolutions.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(preview.conflicts, id: \.self) { path in
                        Text(path).font(.system(.caption, design: .monospaced))
                    }
                    HStack {
                        Button("Ask the model to resolve these") {
                            Task { await detail.previewConflicts() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(detail.isWorking)

                        Button("Take the remote version") { Task { await detail.takeSide("theirs") } }
                        Button("Keep mine") { Task { await detail.takeSide("ours") } }
                        Button("Stash my work and reset") { Task { await detail.stashAndReset() } }
                            .help("Your changes go to `git stash` and stay recoverable.")
                    }
                }
            } else {
                resolutions
            }
        }
    }

    private var resolutions: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(preview.resolutions) { resolution in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: resolution.isProposed ? "checkmark.circle" : "exclamationmark.triangle")
                            .foregroundStyle(resolution.isProposed ? confidenceTint(resolution.confidence) : .orange)
                        Text(resolution.path).font(.system(.caption, design: .monospaced))
                        if let confidence = resolution.confidence {
                            Text(confidence)
                                .font(.system(size: 9))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(confidenceTint(confidence).opacity(0.18), in: Capsule())
                        }
                        Spacer()
                        Button(selected == resolution.path ? "Hide" : "Review") {
                            selected = selected == resolution.path ? nil : resolution.path
                        }
                        .buttonStyle(.link)
                    }

                    if let reason = resolution.reason {
                        Text(reason).font(.caption2).foregroundStyle(.orange)
                    }
                    if let rationale = resolution.rationale {
                        Text(rationale).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let concerns = resolution.concerns, !concerns.isEmpty {
                        ForEach(concerns, id: \.self) {
                            Label($0, systemImage: "exclamationmark.bubble")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }

                    if selected == resolution.path, let sides = resolution.sides {
                        threeWay(sides: sides, merged: resolution.merged ?? "")
                    }
                }
                .padding(8)
                .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 7))
            }

            HStack {
                Button("Apply the proposals") {
                    Task { await detail.applyConflicts(preview.resolutions.filter(\.isProposed)) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!preview.resolutions.allSatisfy(\.isProposed) || detail.isWorking)
                .help(preview.resolutions.allSatisfy(\.isProposed)
                      ? "Writes these files, stages them and commits the merge"
                      : "Some files still need a decision")

                Button("Take the remote version instead") { Task { await detail.takeSide("theirs") } }
                Button("Stash my work and reset") { Task { await detail.stashAndReset() } }
            }
        }
    }

    private func threeWay(sides: ConflictSides, merged: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            pane("Mine", sides.ours, tint: .blue)
            pane("Theirs", sides.theirs, tint: .purple)
            pane("Proposed", merged, tint: .green)
        }
        .frame(height: 260)
    }

    private func pane(_ title: String, _ body: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption2).bold().foregroundStyle(tint)
            ScrollView([.vertical, .horizontal]) {
                Text(body.isEmpty ? "(empty)" : body)
                    .font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
            }
            .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 5))
        }
        .frame(maxWidth: .infinity)
    }

    private func confidenceTint(_ confidence: String?) -> Color {
        switch confidence {
        case "high": return .green
        case "medium": return .yellow
        default: return .orange
        }
    }
}
