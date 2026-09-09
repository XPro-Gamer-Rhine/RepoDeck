import Foundation

/// An unsolicited line from the engine: progress, a log line, a state change.
///
/// Events are deliberately loosely typed — the engine adds new ones as features
/// land, and an app that refuses to decode an unknown event would go blind
/// exactly when something interesting happened.
struct EngineEvent: Decodable {
    let t: String
    let req: Int?

    let repoId: Int?
    let message: String?
    let phase: String?
    let detail: String?
    let status: String?
    let state: String?
    let stream: String?
    let text: String?
    let reason: String?
    let sha: String?
    let changed: Bool?
    let moved: Bool?
    let conflicts: [String]?
    let commits: Int?
    let count: Int?
    let proposed: Int?
    let kept: Int?
    let alreadyStatic: Int?
    let unknownPath: Int?
    let unprovenEvidence: Int?
    let login: String?

    /// What to show in the activity strip, when there is anything worth showing.
    var displayText: String? {
        if let message, !message.isEmpty { return message }
        if let detail, !detail.isEmpty { return detail }
        if let text, !text.isEmpty { return text }
        return nil
    }

    var isLog: Bool { t == "log" || t == "deploy_log" }
}
