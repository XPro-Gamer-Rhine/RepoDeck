import SwiftUI

/// What has actually happened: the merges that landed, and what RepoDeck did
/// about each of them.
struct HistoryTab: View {
    let repo: Repo
    @ObservedObject var detail: RepoDetail
    @State private var showJobs = false

    var body: some View {
        HSplitView {
            merges
                .frame(minWidth: 380)
            runs
                .frame(minWidth: 280, idealWidth: 360)
        }
        .task {
            await detail.loadCommits()
            await detail.loadJobs()
            await detail.loadPullRequests()
        }
    }

    private var merges: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Merges into \(repo.branch)").font(.headline)
                Spacer()
                if detail.landed.count < detail.commits.count {
                    Button("Summarise older") {
                        Task { await detail.backfillDigests(limit: 5) }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    .disabled(detail.isWorking)
                }
                Text("\(detail.commits.count)").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()

            if detail.commits.isEmpty {
                EmptyStateView(
                    title: "No merge history",
                    message: "RepoDeck reads merge commits on the default branch's first-parent line. A repository that squash-merges falls back to plain first-parent commits.",
                    systemImage: "clock"
                )
            } else {
                List(detail.commits) { commit in
                    // The digest, when one exists, is what a person reads; the
                    // commit subject is what the author happened to type.
                    let digest = detail.landed.first { $0.sha == commit.sha }
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(commit.shortSha)
                                .font(.system(.caption2, design: .monospaced))
                                .foregroundStyle(.secondary)
                            if let pr = commit.prNumber {
                                Text("#\(pr)")
                                    .font(.caption2)
                                    .padding(.horizontal, 4)
                                    .background(.purple.opacity(0.18), in: Capsule())
                            }
                            Text(digest?.headline ?? commit.message ?? "")
                                .font(.callout)
                                .lineLimit(1)
                            if let digest, digest.hasBreaking {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                                    .help(digest.breaking.joined(separator: "\n"))
                            }
                        }
                        if let digest, let overview = digest.overview, !overview.isEmpty {
                            Text(overview)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        HStack(spacing: 10) {
                            Text(commit.author ?? "unknown")
                            Text(Timestamps.relative(commit.committedAt))
                            Text("\(commit.files) files")
                            Text("\(commit.churn) lines")
                        }
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }
                .listStyle(.inset)
            }
        }
    }

    private var runs: some View {
        VStack(spacing: 0) {
            HStack {
                Text("What RepoDeck did").font(.headline)
                Spacer()
                Button {
                    Task { await detail.loadJobs() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            Divider()

            List(detail.jobs) { job in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon(for: job))
                        .foregroundStyle(tint(for: job.status))
                        .font(.caption)
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(job.type.capitalized).font(.caption).bold()
                            Text(job.status).font(.caption2).foregroundStyle(tint(for: job.status))
                            Spacer()
                            Text(Timestamps.relative(job.finishedAt ?? job.startedAt))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        if let message = job.message {
                            Text(message)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .listStyle(.inset)
            .overlay {
                if detail.jobs.isEmpty {
                    Text("Nothing has run yet.").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func icon(for job: JobInfo) -> String {
        switch job.type {
        case "index": return "square.grid.3x3"
        case "sync": return "arrow.triangle.2.circlepath"
        case "deploy": return "play.rectangle"
        case "conflict": return "arrow.triangle.merge"
        case "clone": return "arrow.down.doc"
        default: return "circle"
        }
    }

    private func tint(for status: String) -> Color {
        switch status {
        case "ok": return .green
        case "error": return .red
        case "blocked": return .orange
        case "partial": return .yellow
        case "running": return .accentColor
        default: return .secondary
        }
    }
}
