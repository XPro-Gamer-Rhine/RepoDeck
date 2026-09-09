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
            return "Node.js was not found. Install it (`brew install node`) or rebuild RepoDeck with --bundle-node."
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

    private static func findNode() -> URL? {
        let fm = FileManager.default

        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("bin/node"),
           fm.isExecutableFile(atPath: bundled.path) {
            return bundled
        }

        if let override = ProcessInfo.processInfo.environment["REPODECK_NODE"],
           fm.isExecutableFile(atPath: override) {
            return URL(fileURLWithPath: override)
        }

        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where fm.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }

        return whichNode()
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
