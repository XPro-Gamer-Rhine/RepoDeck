import Foundation
import Combine

/// The `{ id, ok, result }` wrapper every RPC response arrives in.
private struct RPCEnvelope<R: Decodable>: Decodable {
    let result: R?
}

struct EngineError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The app's single connection to the Node engine.
///
/// One `node index.js daemon` process is started at launch and kept for the
/// session. That matters more here than it would for a stateless tool: the
/// engine owns the cron tasks and the PR watchers, and it supervises the dev
/// servers RepoDeck starts — all of which have to outlive any one screen.
///
/// Requests are line-delimited JSON on the child's stdin; responses and events
/// come back as NDJSON on stdout. Secrets only ever travel this pipe.
@MainActor
final class EngineClient: ObservableObject {
    @Published private(set) var isReady = false
    @Published private(set) var startupError: String?

    /// Fired for every event line not tied to an in-flight request.
    var onEvent: ((EngineEvent) -> Void)?

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var buffer = Data()
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var eventSinks: [Int: (EngineEvent) -> Void] = [:]
    private var stderrTail = ""
    private var intentionalShutdown = false
    private var restartAttempts = 0
    private var restartTask: Task<Void, Never>?

    /// Called after the engine has been restarted, so the app can re-push
    /// credentials and refresh — the new process starts with nothing.
    var onRestart: (() -> Void)?

    // MARK: - Lifecycle

    func start() {
        guard process == nil else { return }
        intentionalShutdown = false
        let resolved: EngineLocation
        do {
            resolved = try EngineLocator.resolve()
        } catch {
            startupError = error.localizedDescription
            return
        }

        let proc = Process()
        proc.executableURL = resolved.node
        proc.arguments = [resolved.script.path, "daemon"]

        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.ingest(data) }
        }
        // The engine's own stderr is the first place a crash shows up; surface it
        // rather than letting it vanish into a pipe nobody reads, and keep the
        // tail so an early exit can be explained instead of just reported.
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in
                self?.recordStderr(text)
                self?.onEvent?(EngineEvent.log(stream: "engine", text: text))
            }
        }
        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in self?.handleExit(code: p.terminationStatus) }
        }

        do {
            try proc.run()
        } catch {
            startupError = "Failed to launch the RepoDeck engine: \(error.localizedDescription)"
            return
        }
        process = proc
        stdinHandle = inPipe.fileHandleForWriting
        startupError = nil
    }

    func stop() {
        guard let proc = process else { return }
        intentionalShutdown = true
        // Ask politely first: this is what stops the dev servers the engine
        // supervises, and killing it outright would orphan them.
        _ = try? send(["id": 0, "method": "app.shutdown", "params": [:]])
        process = nil
        stdinHandle = nil
        isReady = false
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.2) {
            if proc.isRunning { proc.terminate() }
        }
    }

    private func recordStderr(_ text: String) {
        stderrTail.append(text)
        if stderrTail.count > 4000 { stderrTail.removeFirst(stderrTail.count - 4000) }
    }

    private func handleExit(code: Int32) {
        let wasReady = isReady
        isReady = false
        process = nil
        stdinHandle = nil

        // An exit before the daemon ever announced itself is a startup failure,
        // and the reason is almost always sitting in stderr. Saying "the engine
        // exited" without it sends the user hunting through Console.
        if !wasReady && !intentionalShutdown {
            startupError = diagnose(code: code)
        }

        // An engine that dies after a good start takes every schedule, watcher and
        // supervised dev server with it, and nothing brought it back — the app just
        // stopped working until it was quit and relaunched. Restart it, with a
        // backoff and a cap so a genuinely broken engine is not respawned forever.
        if wasReady && !intentionalShutdown {
            scheduleRestart(after: code)
        }

        let failures = pending.values
        pending.removeAll()
        eventSinks.removeAll()
        for cont in failures {
            cont.resume(throwing: EngineError(message: "The engine exited (code \(code))."))
        }
    }

    private func scheduleRestart(after code: Int32) {
        guard restartAttempts < 5 else {
            startupError = """
            The RepoDeck engine has stopped repeatedly and will not be restarted again. \
            Quit and reopen RepoDeck; if it keeps happening, the last error was:

            \(stderrTail.suffix(400))
            """
            return
        }
        restartAttempts += 1
        let delay = UInt64(min(8, 1 << (restartAttempts - 1))) * 1_000_000_000

        restartTask?.cancel()
        restartTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self, !Task.isCancelled else { return }
            self.onEvent?(EngineEvent.log(
                stream: "engine",
                text: "[RepoDeck] the engine exited (code \(code)); restarting — attempt \(self.restartAttempts)\n"
            ))
            self.stderrTail = ""
            self.start()

            // Give the daemon a moment to announce itself, then hand it back the
            // credentials and let the app resync.
            for _ in 0..<60 where !self.isReady {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            if self.isReady {
                self.restartAttempts = 0
                self.onRestart?()
            }
        }
    }

    /// Turn the engine's dying words into something the user can act on.
    private func diagnose(code: Int32) -> String {
        let tail = stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)

        if tail.contains("NODE_MODULE_VERSION") || tail.contains("ERR_DLOPEN_FAILED") {
            return """
            The engine could not load its database driver — the installed Node does not match             the one its native module was built for. Reinstall the engine's dependencies:

            cd <RepoDeck>/engine && npm install
            """
        }
        if tail.contains("node:sqlite") || tail.contains("Cannot find module 'node:sqlite'") {
            return "The engine needs Node 22.5 or newer for its built-in SQLite. Install a current Node (brew install node) and reopen RepoDeck."
        }
        if tail.contains("Cannot find module") {
            return "The engine is missing its dependencies. Run `npm install` in RepoDeck's engine directory.\n\n\(tail.suffix(400))"
        }
        if tail.isEmpty {
            return "The RepoDeck engine exited immediately (code \(code)) without saying why."
        }
        return "The RepoDeck engine exited (code \(code)):\n\n\(tail.suffix(600))"
    }

    // MARK: - Calling

    /// Send an RPC and decode its result.
    ///
    /// `onEvent` receives only the events this call produced — one index's
    /// progress, one deploy's log — while everything else goes to the global sink.
    @discardableResult
    func call<T: Decodable>(
        _ method: String,
        _ params: [String: Any] = [:],
        as type: T.Type = T.self,
        onEvent sink: ((EngineEvent) -> Void)? = nil
    ) async throws -> T {
        let id = nextID
        nextID += 1
        if let sink { eventSinks[id] = sink }
        defer { eventSinks[id] = nil }

        let data: Data = try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            do {
                try send(["id": id, "method": method, "params": params])
            } catch {
                pending[id] = nil
                cont.resume(throwing: error)
            }
        }

        guard let result = try JSONDecoder().decode(RPCEnvelope<T>.self, from: data).result else {
            throw EngineError(message: "\(method) returned no result")
        }
        return result
    }

    /// A call whose result we don't need.
    func callVoid(
        _ method: String,
        _ params: [String: Any] = [:],
        onEvent sink: ((EngineEvent) -> Void)? = nil
    ) async throws {
        _ = try await call(method, params, as: JSONValue.self, onEvent: sink)
    }

    private func send(_ payload: [String: Any]) throws {
        guard let handle = stdinHandle else {
            throw EngineError(message: "The RepoDeck engine isn't running.")
        }
        var line = try JSONSerialization.data(withJSONObject: payload)
        line.append(0x0A)
        try handle.write(contentsOf: line)
    }

    // MARK: - Reading

    private func ingest(_ data: Data) {
        buffer.append(data)
        let newline = UInt8(ascii: "\n")
        while let idx = buffer.firstIndex(of: newline) {
            let lineData = buffer.subdata(in: buffer.startIndex..<idx)
            buffer.removeSubrange(buffer.startIndex...idx)
            guard !lineData.isEmpty else { continue }
            route(lineData)
        }
    }

    /// One line is either an RPC response (has `id`) or an event (has `t`).
    private func route(_ line: Data) {
        struct Head: Decodable {
            let id: Int?
            let ok: Bool?
            let error: String?
            let t: String?
            let req: Int?
        }
        guard let head = try? JSONDecoder().decode(Head.self, from: line) else { return }

        if let id = head.id, let cont = pending.removeValue(forKey: id) {
            if head.ok == true {
                cont.resume(returning: line)
            } else {
                cont.resume(throwing: EngineError(message: head.error ?? "unknown engine error"))
            }
            return
        }

        guard head.t != nil, let event = try? JSONDecoder().decode(EngineEvent.self, from: line) else {
            return
        }
        if event.t == "ready" { isReady = true }
        if let req = head.req, let sink = eventSinks[req] {
            sink(event)
        } else {
            onEvent?(event)
        }
    }
}

extension EngineEvent {
    /// Synthesised locally, for the engine's own stderr.
    static func log(stream: String, text: String) -> EngineEvent {
        let payload: [String: Any] = ["t": "log", "stream": stream, "text": text]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(EngineEvent.self, from: data)
    }
}
