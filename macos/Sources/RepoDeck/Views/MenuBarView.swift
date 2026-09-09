import SwiftUI

/// The menubar item: what is current, what is running, and one click to sync —
/// without bringing the main window forward.
struct MenuBarView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("RepoDeck").font(.headline)
                Spacer()
                if !app.engine.isReady {
                    Text("engine offline").font(.caption2).foregroundStyle(.orange)
                }
            }

            Divider()

            if app.repos.isEmpty {
                Text("No repositories yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(app.repos) { repo in
                    HStack(spacing: 8) {
                        StatusDot(status: repo.status, deployState: repo.deployState)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(repo.name).font(.callout)
                            Text(statusLine(for: repo)).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if repo.deployState == "running", let port = repo.deployProfile?.port,
                           let url = URL(string: "http://localhost:\(port)") {
                            Link(destination: url) { Image(systemName: "safari") }
                                .help("Open localhost:\(port)")
                        }
                        Button {
                            Task {
                                _ = try? await app.engine.call("sched.runNow", ["repoId": repo.id], as: JSONValue.self)
                            }
                        } label: {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        .buttonStyle(.borderless)
                        .help("Pull, re-index and redeploy now")
                        .disabled(repo.isBusy)
                    }
                    .padding(.vertical, 1)
                }
            }

            Divider()

            if let latest = app.activity.last {
                Text(latest.text)
                    .font(.caption2)
                    .foregroundStyle(latest.isError ? .red : .secondary)
                    .lineLimit(2)
            }

            HStack {
                Button("Open RepoDeck") {
                    NSApp.activate(ignoringOtherApps: true)
                    for window in NSApp.windows where window.canBecomeMain {
                        window.makeKeyAndOrderFront(nil)
                        break
                    }
                }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .font(.caption)
        }
        .padding(12)
        .frame(width: 320)
    }

    private func statusLine(for repo: Repo) -> String {
        if repo.isBusy, let progress = repo.progress, !progress.isEmpty { return progress }
        if repo.status == "error" { return repo.statusDetail ?? "needs attention" }
        var parts = [repo.branch, "indexed \(Timestamps.relative(repo.lastIndexedAt))"]
        if repo.deployState == "running" { parts.append("running") }
        return parts.joined(separator: " · ")
    }
}
