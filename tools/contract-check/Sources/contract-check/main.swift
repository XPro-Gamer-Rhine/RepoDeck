// Decode a captured engine payload with the type the app really uses.
//
//   contract-check <TypeName> <payload.json>
//
// Exits 0 on a clean decode, 1 with the decoding error otherwise.
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage: contract-check <TypeName> <payload.json>\n".utf8))
    exit(2)
}

let typeName = arguments[1]
guard let payload = try? Data(contentsOf: URL(fileURLWithPath: arguments[2])) else {
    print("FAIL \(typeName): could not read \(arguments[2])")
    exit(1)
}

let decoder = JSONDecoder()

func attempt<T: Decodable>(_ type: T.Type) -> String? {
    do {
        _ = try decoder.decode(type, from: payload)
        return nil
    } catch {
        return "\(error)"
    }
}

// Every type the app decodes an RPC result into.
let decoders: [String: () -> String?] = [
    "AppState": { attempt(AppState.self) },
    "Repo": { attempt(Repo.self) },
    "RepoListResult": { attempt(RepoListResult.self) },
    "RemoteInspection": { attempt(RemoteInspection.self) },
    "GraphData": { attempt(GraphData.self) },
    "HotspotList": { attempt(HotspotList.self) },
    "FileDetail": { attempt(FileDetail.self) },
    "SymbolDetail": { attempt(SymbolDetail.self) },
    "CommitList": { attempt(CommitList.self) },
    "ActivityResult": { attempt(ActivityResult.self) },
    "KnowledgeGraph": { attempt(KnowledgeGraph.self) },
    "JobList": { attempt(JobList.self) },
    "PullRequestList": { attempt(PullRequestList.self) },
    "PRSummaryList": { attempt(PRSummaryList.self) },
    "DeployStatus": { attempt(DeployStatus.self) },
    "DeployDetection": { attempt(DeployDetection.self) },
    "DeployStartResult": { attempt(DeployStartResult.self) },
    "LogResult": { attempt(LogResult.self) },
    "WorktreeStatus": { attempt(WorktreeStatus.self) },
    "PullResult": { attempt(PullResult.self) },
    "IndexResult": { attempt(IndexResult.self) },
    "ConflictPreview": { attempt(ConflictPreview.self) },
    "ExportResult": { attempt(ExportResult.self) },
    "MarkdownResult": { attempt(MarkdownResult.self) },
    "Account": { attempt(Account.self) },
    "PingResult": { attempt(PingResult.self) },
    "GitHubRepoList": { attempt(GitHubRepoList.self) },
]

guard let decode = decoders[typeName] else {
    print("FAIL: no decoder registered for \(typeName)")
    exit(2)
}

if let failure = decode() {
    print("FAIL \(typeName)")
    print("  \(failure)")
    exit(1)
}
print("ok   \(typeName)")
