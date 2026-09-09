import SwiftUI

/// Running the repository locally.
///
/// Nothing here executes until a profile has been saved, and the profile is
/// shown as the exact shell commands that will run. RepoDeck proposes; the user
/// approves. After that, a merge landing on the default branch restarts the
/// process with the new code.
struct DeployTab: View {
    let repo: Repo
    @ObservedObject var detail: RepoDetail

    @State private var detection: DeployDetection?
    @State private var profile: DeployProfile?
    @State private var editing = false
    @State private var autoScroll = true

    var body: some View {
        VSplitView {
            VStack(alignment: .leading, spacing: 14) {
                if let profile {
                    profileCard(profile)
                } else {
                    detectCard
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(minHeight: 200)

            logView
                .frame(minHeight: 160)
        }
        .task {
            await detail.loadDeployStatus()
            await detail.loadDeployLogs()
            profile = detail.deployStatus?.profile ?? repo.deployProfile
            if profile == nil { detection = await detail.detectDeploy() }
        }
    }

    // MARK: - Detection

    private var detectCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let detection {
                SectionCard(
                    title: "Detected: \(detection.profile.label)",
                    subtitle: detection.profile.detectedFrom,
                    systemImage: "wand.and.stars"
                ) {
                    commandPreview(detection.profile)

                    if detection.profile.envMissing == true {
                        Label(
                            "\(detection.profile.envExample ?? ".env.example") exists but .env does not — the app will probably fail to start until you create one.",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }

                    HStack {
                        Button("Approve and enable") {
                            Task {
                                await detail.saveDeployProfile(detection.profile)
                                profile = detection.profile
                            }
                        }
                        .buttonStyle(.borderedProminent)

                        Button("Edit first") {
                            profile = detection.profile
                            editing = true
                        }
                    }
                }

                if detection.candidates.count > 1 {
                    SectionCard(title: "Other ways to run this", systemImage: "list.bullet") {
                        ForEach(Array(detection.candidates.dropFirst().enumerated()), id: \.offset) { _, candidate in
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(candidate.label).font(.callout)
                                    Text(candidate.run).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Use this") {
                                    profile = candidate
                                    editing = true
                                }
                                .buttonStyle(.link)
                            }
                        }
                    }
                }
            } else {
                EmptyStateView(
                    title: "Nothing to run yet",
                    message: "Clone and index the repository first, then RepoDeck can work out how it starts.",
                    systemImage: "play.slash"
                )
            }
        }
    }

    // MARK: - Profile

    private func profileCard(_ current: DeployProfile) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionCard(title: "Run profile", subtitle: current.detectedFrom, systemImage: "play.rectangle") {
                if editing {
                    editor(current)
                } else {
                    commandPreview(current)
                    HStack {
                        Button("Edit") { editing = true }
                        Button("Re-detect") {
                            Task {
                                detection = await detail.detectDeploy()
                                if let detected = detection?.profile { profile = detected; editing = true }
                            }
                        }
                    }
                }
            }

            SectionCard(title: "State", systemImage: "bolt.horizontal") {
                HStack(spacing: 16) {
                    StatTile(
                        value: detail.deployStatus?.state ?? repo.deployState,
                        label: "process",
                        tint: stateTint
                    )
                    if let pid = detail.deployStatus?.pid { StatTile(value: "\(pid)", label: "pid") }
                    if let port = current.port { StatTile(value: "\(port)", label: "port") }
                    StatTile(
                        value: Timestamps.relative(detail.deployStatus?.startedAt),
                        label: "started"
                    )
                    Spacer()
                }

                HStack {
                    if detail.deployStatus?.state == "running" {
                        Button {
                            Task { await detail.stopDeploy() }
                        } label: {
                            Label("Stop", systemImage: "stop.fill")
                        }
                        if let port = current.port, let url = URL(string: "http://localhost:\(port)") {
                            Link(destination: url) {
                                Label("Open localhost:\(port)", systemImage: "safari")
                            }
                        }
                    } else {
                        Button {
                            Task { await detail.startDeploy(install: false) }
                        } label: {
                            Label("Start", systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)

                        Button {
                            Task { await detail.startDeploy(install: true) }
                        } label: {
                            Label("Install then start", systemImage: "arrow.down.circle")
                        }
                    }

                    Spacer()

                    Toggle("Redeploy after every merge", isOn: Binding(
                        get: { repo.autoDeploy },
                        set: { value in
                            Task { await detail.setAutoDeploy(value) }
                        }
                    ))
                    .toggleStyle(.switch)
                    .help("When a merge lands on \(repo.branch), RepoDeck pulls, re-indexes and restarts this process with the new code.")
                }
            }
        }
    }

    private var stateTint: Color {
        switch detail.deployStatus?.state ?? repo.deployState {
        case "running": return .green
        case "failed": return .red
        case "starting": return .orange
        default: return .secondary
        }
    }

    private func commandPreview(_ p: DeployProfile) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !p.install.isEmpty { commandRow("install", p.install) }
            commandRow("run", p.run)
            if !p.stop.isEmpty { commandRow("stop", p.stop) }
            HStack(spacing: 14) {
                if let port = p.port { Label("port \(port)", systemImage: "network").font(.caption2) }
                if let env = p.envFile { Label(env, systemImage: "doc.text").font(.caption2) }
                Label("in \(p.cwd ?? ".")", systemImage: "folder").font(.caption2)
            }
            .foregroundStyle(.secondary)
        }
    }

    private func commandRow(_ label: String, _ command: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
                .frame(width: 46, alignment: .trailing)
            Text(command)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 5))
        }
    }

    private func editor(_ current: DeployProfile) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            field("Install", text: Binding(
                get: { current.install },
                set: { profile?.install = $0 }
            ))
            field("Run", text: Binding(
                get: { current.run },
                set: { profile?.run = $0 }
            ))
            field("Stop", text: Binding(
                get: { current.stop },
                set: { profile?.stop = $0 }
            ))
            field("Working dir", text: Binding(
                get: { current.cwd ?? "." },
                set: { profile?.cwd = $0 }
            ))
            HStack {
                Text("Health port").font(.caption).frame(width: 90, alignment: .trailing)
                TextField("optional", value: Binding(
                    get: { current.port ?? 0 },
                    set: { profile?.port = $0 == 0 ? nil : $0 }
                ), format: .number)
                .textFieldStyle(.roundedBorder)
                .frame(width: 100)
                Text("RepoDeck waits for this port to accept a connection before calling the app healthy.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") {
                    editing = false
                    profile = detail.deployStatus?.profile ?? repo.deployProfile
                }
                Button("Save") {
                    guard let profile else { return }
                    Task {
                        await detail.saveDeployProfile(profile)
                        editing = false
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        HStack {
            Text(label).font(.caption).frame(width: 90, alignment: .trailing)
            TextField("", text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
        }
    }

    // MARK: - Logs

    private var logView: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Output").font(.headline)
                Spacer()
                Toggle("Follow", isOn: $autoScroll).toggleStyle(.checkbox).font(.caption)
                Button {
                    Task { await detail.loadDeployLogs() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(detail.deployLogs.map(\.text).joined(separator: "\n"), forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(detail.deployLogs.enumerated()), id: \.offset) { index, line in
                            Text(line.text)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundStyle(line.stream == "stderr" ? Color.orange : .primary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(index)
                        }
                        if detail.deployLogs.isEmpty {
                            Text("No output yet.").font(.caption).foregroundStyle(.tertiary).padding()
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .onChange(of: detail.deployLogs.count) { _, count in
                    guard autoScroll, count > 0 else { return }
                    withAnimation { proxy.scrollTo(count - 1, anchor: .bottom) }
                }
            }
        }
        .background(.quaternary.opacity(0.2))
    }
}

extension RepoDetail {
    func setAutoDeploy(_ value: Bool) async {
        _ = try? await engine.call(
            "repo.update", ["repoId": repoId, "autoDeploy": value], as: JSONValue.self
        )
        await loadDeployStatus()
    }
}
