import SwiftUI

/// The window: repositories down the left, one repository's dashboard on the
/// right, and a thin activity strip along the bottom that shows what the engine
/// is doing right now — including the work nobody asked for, like a scheduled
/// sync firing at 3am.
struct MainWindowView: View {
    @EnvironmentObject private var app: AppModel
    @State private var showAddRepo = false
    @State private var showActivity = true

    var body: some View {
        Group {
            if app.isBooting {
                bootScreen
            } else if app.account == nil && app.repos.isEmpty {
                OnboardingView()
            } else {
                split
            }
        }
        .sheet(isPresented: $showAddRepo) {
            AddRepoView()
                .environmentObject(app)
        }
        .overlay(alignment: .top) { bannerView }
    }

    private var bootScreen: some View {
        VStack(spacing: 14) {
            ProgressView()
            Text("Starting the RepoDeck engine…").foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var split: some View {
        NavigationSplitView {
            SidebarView(showAddRepo: $showAddRepo)
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        } detail: {
            VStack(spacing: 0) {
                if let repo = app.selectedRepo {
                    RepoDashboardView(repo: repo, app: app)
                        .id(repo.id) // a new repository gets a fresh detail model
                } else {
                    EmptyStateView(
                        title: "No repository selected",
                        message: "Add a repository to see its architecture graph, its knowledge graph and its deploy state.",
                        systemImage: "point.3.connected.trianglepath.dotted",
                        actionTitle: "Add repository",
                        action: { showAddRepo = true }
                    )
                }

                if showActivity {
                    Divider()
                    activityStrip
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showAddRepo = true
                } label: {
                    Label("Add repository", systemImage: "plus")
                }
                .help("Clone a repository by pasting its SSH or HTTPS URL")
            }
            ToolbarItem(placement: .automatic) {
                Button {
                    withAnimation { showActivity.toggle() }
                } label: {
                    Label("Activity", systemImage: showActivity ? "chevron.down.square" : "chevron.up.square")
                }
                .help(showActivity ? "Hide the activity strip" : "Show the activity strip")
            }
        }
    }

    private var activityStrip: some View {
        let lines = app.activity(for: app.selectedRepoID).suffix(60).reversed()
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(Array(lines)) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(line.at, style: .time)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.tertiary)
                        Text(line.text)
                            .font(.caption)
                            .foregroundStyle(line.isError ? Color.red : .secondary)
                            .lineLimit(1)
                    }
                }
                if lines.isEmpty {
                    Text("Nothing happening.").font(.caption).foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .frame(height: 120)
        .background(.quaternary.opacity(0.25))
    }

    @ViewBuilder private var bannerView: some View {
        if let banner = app.banner {
            HStack(spacing: 10) {
                Image(systemName: icon(for: banner.level))
                VStack(alignment: .leading, spacing: 2) {
                    Text(banner.title).font(.callout).bold()
                    if let detail = banner.detail {
                        Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                Spacer()
                Button {
                    app.banner = nil
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
            }
            .padding(12)
            .frame(maxWidth: 620)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(tint(for: banner.level).opacity(0.5), lineWidth: 1))
            .shadow(radius: 12)
            .padding(.top, 10)
            .transition(.move(edge: .top).combined(with: .opacity))
            .task(id: banner.id) {
                // Errors stay until dismissed; everything else clears itself.
                guard banner.level != .error else { return }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if app.banner?.id == banner.id { app.banner = nil }
            }
        }
    }

    private func icon(for level: AppModel.Banner.Level) -> String {
        switch level {
        case .info: return "info.circle"
        case .warning: return "exclamationmark.triangle"
        case .error: return "xmark.octagon"
        case .success: return "checkmark.circle"
        }
    }

    private func tint(for level: AppModel.Banner.Level) -> Color {
        switch level {
        case .info: return .accentColor
        case .warning: return .orange
        case .error: return .red
        case .success: return .green
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var app: AppModel
    @Binding var showAddRepo: Bool
    @State private var confirmDelete: Repo?

    var body: some View {
        List(selection: $app.selectedRepoID) {
            if let account = app.account {
                Section {
                    HStack(spacing: 8) {
                        Image(systemName: "person.crop.circle")
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(account.displayName).font(.callout)
                            Text("@\(account.login)").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !account.canReadPrivate {
                            Image(systemName: "lock.open")
                                .foregroundStyle(.orange)
                                .help("This token has no `repo` scope, so private repositories are not visible.")
                        }
                    }
                    .padding(.vertical, 2)
                }
            }

            Section("Repositories") {
                ForEach(app.repos) { repo in
                    row(repo)
                        .tag(repo.id)
                        .contextMenu {
                            Button("Reveal in Finder") {
                                NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: repo.workdir)
                            }
                            Button("Open on GitHub") {
                                if let url = URL(string: webURL(for: repo)) { NSWorkspace.shared.open(url) }
                            }
                            Divider()
                            Button("Remove…", role: .destructive) { confirmDelete = repo }
                        }
                }
                if app.repos.isEmpty {
                    Text("No repositories yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Divider()
                HStack {
                    Button {
                        showAddRepo = true
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .buttonStyle(.borderless)

                    Spacer()

                    if !app.hasProvider {
                        Label("No AI provider", systemImage: "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .help("Add a Claude, OpenAI or local model in Settings to get analysis and knowledge graphs.")
                    }

                    SettingsLink {
                        Image(systemName: "gearshape")
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
            }
        }
        .confirmationDialog(
            "Remove \(confirmDelete?.name ?? "")?",
            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove, keep the clone", role: .destructive) {
                if let repo = confirmDelete { Task { await app.removeRepo(repo.id, deleteFiles: false) } }
                confirmDelete = nil
            }
            Button("Remove and delete the clone", role: .destructive) {
                if let repo = confirmDelete { Task { await app.removeRepo(repo.id, deleteFiles: true) } }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("This removes the graph, the knowledge graph and the schedule. Deleting the clone also removes the working tree at \(confirmDelete?.workdir ?? "").")
        }
    }

    private func row(_ repo: Repo) -> some View {
        HStack(spacing: 8) {
            StatusDot(status: repo.status, deployState: repo.deployState)
            VStack(alignment: .leading, spacing: 1) {
                Text(repo.name).lineLimit(1)
                HStack(spacing: 5) {
                    Text(repo.branch)
                    if repo.counts.openPrs > 0 {
                        Text("· \(repo.counts.openPrs) PR")
                    }
                    if repo.deployState == "running" {
                        Image(systemName: "play.circle.fill").foregroundStyle(.green)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer()
            if repo.isBusy {
                ProgressView().controlSize(.mini)
            }
        }
        .padding(.vertical, 1)
        .help(repo.progress?.isEmpty == false ? repo.progress! : repo.url)
    }

    private func webURL(for repo: Repo) -> String {
        guard let owner = repo.owner, let host = repo.host, host != "local" else { return repo.url }
        return "https://\(host)/\(owner)/\(repo.name)"
    }
}
