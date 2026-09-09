import Foundation

struct EngineLocation {
    let node: URL   // path to the node executable
    let script: URL // path to engine/index.js
}

enum EngineLocatorError: LocalizedError {
    case nodeNotFound
    case scriptNotFound

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return """
            RepoDeck needs Node.js 22.5 or newer and could not find it.

            Install it with `brew install node`, then reopen RepoDeck. If Node is \
            installed somewhere unusual, set REPODECK_NODE to its full path.
            """
        case .scriptNotFound:
            return "The RepoDeck engine (engine/index.js) could not be located."
        }
    }
}

/// Locates the Node runtime and the engine script at run time.
///
/// Node lookup order:
///   1. A node binary bundled at Contents/Resources/bin/node
///   2. `REPODECK_NODE` environment override
///   3. Common install locations (Homebrew arm64/Intel, /usr/local, /usr/bin)
///   4. A login shell's PATH, which is where nvm and asdf put it
///
/// Script lookup order:
///   1. Contents/Resources/engine/index.js  (packaged app)
///   2. `REPODECK_ENGINE` environment override
///   3. ../engine/index.js relative to the executable  (dev: `swift run`)
enum EngineLocator {
    static func resolve() throws -> EngineLocation {
        guard let node = findNode() else { throw EngineLocatorError.nodeNotFound }
        guard let script = findScript() else { throw EngineLocatorError.scriptNotFound }
        return EngineLocation(node: node, script: script)
    }

    /// The engine stores its data through `node:sqlite`, which arrived in 22.5.
    private static let minimumNode = (major: 22, minor: 5)

    /// Finds a Node the engine can actually run on.
    ///
    /// Taking the first node on a fixed list is not enough. A developer machine
    /// commonly has several — Homebrew's current one, plus an older nvm or asdf
    /// build a project pinned years ago — and picking one below 22.5 leaves the
    /// engine with no way to open its database. So every candidate is version
    /// checked and the first capable one wins.
    ///
    /// If none qualifies the newest is still returned: the engine's own error
    /// names the version it needs, which is far more use than "Node.js was not
    /// found" on a machine where node is plainly installed.
    private static func findNode() -> URL? {
        let fm = FileManager.default

        // An explicit choice is honoured as given — including a deliberately old
        // one, which is the only way to exercise the better-sqlite3 fallback.
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("bin/node"),
           fm.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        if let override = ProcessInfo.processInfo.environment["REPODECK_NODE"],
           fm.isExecutableFile(atPath: override) {
            return URL(fileURLWithPath: override)
        }

        var candidates: [URL] = []
        var seen = Set<String>()
        func consider(_ url: URL?) {
            guard let url else { return }
            let real = url.resolvingSymlinksInPath().path
            guard fm.isExecutableFile(atPath: url.path), seen.insert(real).inserted else { return }
            candidates.append(url)
        }

        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            consider(URL(fileURLWithPath: path))
        }
        consider(whichNode())            // nvm, asdf, fnm, volta
        guard !candidates.isEmpty else { return nil }

        let versioned = candidates.map { ($0, version(of: $0)) }
        if let capable = versioned.first(where: { supportsBuiltinSQLite($0.1) }) {
            return capable.0
        }
        // Nothing qualifies. Offer the newest, so the message the user reads
        // comes from the engine and names a version.
        return versioned.max { lhs, rhs in (lhs.1 ?? (0, 0)) < (rhs.1 ?? (0, 0)) }?.0 ?? candidates[0]
    }

    private static func supportsBuiltinSQLite(_ v: (major: Int, minor: Int)?) -> Bool {
        guard let v else { return false }
        return v.major > minimumNode.major
            || (v.major == minimumNode.major && v.minor >= minimumNode.minor)
    }

    /// `node -v`, parsed. nil when the binary will not run at all — a stale nvm
    /// shim pointing at a deleted install is executable and still fails.
    private static func version(of node: URL) -> (major: Int, minor: Int)? {
        let proc = Process()
        proc.executableURL = node
        proc.arguments = ["-v"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0,
              let out = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "v"))
        else { return nil }
        let parts = out.split(separator: ".").compactMap { Int($0) }
        guard parts.count >= 2 else { return nil }
        return (parts[0], parts[1])
    }

    private static func whichNode() -> URL? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let out = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !out.isEmpty,
            FileManager.default.isExecutableFile(atPath: out)
        else { return nil }
        return URL(fileURLWithPath: out)
    }

    private static func findScript() -> URL? {
        let fm = FileManager.default

        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("engine/index.js"),
           fm.fileExists(atPath: bundled.path) {
            return bundled
        }

        if let override = ProcessInfo.processInfo.environment["REPODECK_ENGINE"],
           fm.fileExists(atPath: override) {
            return URL(fileURLWithPath: override)
        }

        // Dev fallback: the repo layout is <root>/macos and <root>/engine.
        let exec = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        let devPaths = [
            exec.deletingLastPathComponent()            // .build/<arch>/release
                .appendingPathComponent("../../../engine/index.js"),
            URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("../engine/index.js"),
            URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("engine/index.js"),
        ]
        for p in devPaths {
            let resolved = p.standardizedFileURL
            if fm.fileExists(atPath: resolved.path) { return resolved }
        }
        return nil
    }
}
