import SwiftUI

/// The knowledge graph, as the app shows it.
///
/// This is the same material the export bundle carries — overview, modules, API
/// surface, data model, screens, configuration, change history. It is worth
/// reading here because it is also the fastest way to see whether the model got
/// the repository right before you hand the bundle to an agent.
struct KnowledgeTab: View {
    let repo: Repo
    @ObservedObject var detail: RepoDetail
    @State private var section: Section = .overview
    @State private var search = ""

    enum Section: String, CaseIterable, Identifiable {
        case overview, flows, playbooks, api, functions, errors, modules, data, screens, config, changes
        var id: String { rawValue }
        var label: String {
            switch self {
            case .overview: return "Overview"
            case .flows: return "Flows"
            case .playbooks: return "Playbooks"
            case .api: return "API"
            case .functions: return "Functions"
            case .errors: return "Errors"
            case .modules: return "Modules"
            case .data: return "Data"
            case .screens: return "Screens"
            case .config: return "Config"
            case .changes: return "Changes"
            }
        }
    }

    var body: some View {
        Group {
            if detail.isLoadingKnowledge {
                ProgressView("Reading the knowledge graph…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let kg = detail.knowledge, !kg.isEmpty {
                content(kg)
            } else {
                EmptyStateView(
                    title: "No knowledge graph yet",
                    message: "The knowledge graph is what a Claude agent reads before it touches this repository: what the code does, which screen calls which endpoint, what each payload looks like, and what changed most recently. It is built during indexing and refreshed on every pull.",
                    systemImage: "book.closed",
                    actionTitle: "Build it now",
                    action: { Task { await detail.buildKnowledge() } }
                )
            }
        }
        .task {
            if detail.knowledge == nil { await detail.loadKnowledge() }
        }
    }

    private func content(_ kg: KnowledgeGraph) -> some View {
        VStack(spacing: 0) {
            // A fixed-width segmented picker plus a search field plus two labelled
            // buttons needs more room than the window's minimum width, and an
            // overflowing HStack does not clip politely — it pushes the entire
            // detail pane sideways. Everything here now shrinks or collapses.
            HStack(spacing: 8) {
                Picker("", selection: $section) {
                    ForEach(Section.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .layoutPriority(1)

                TextField("Search", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 90, idealWidth: 150, maxWidth: 200)

                Button {
                    copyClaudeMd()
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .help("Copy CLAUDE.md — the agent-facing document — to the clipboard")

                Button {
                    Task { await detail.buildKnowledge() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Rebuild the knowledge graph from the current code")
                .disabled(detail.isWorking)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch section {
                    case .overview: overview(kg)
                    case .flows: flows(kg)
                    case .playbooks: playbooks(kg)
                    case .api: api(kg)
                    case .functions: functions(kg)
                    case .errors: errors(kg)
                    case .modules: modules(kg)
                    case .data: data(kg)
                    case .screens: screens(kg)
                    case .config: config(kg)
                    case .changes: changes(kg)
                    }
                }
                .padding(14)
            }
        }
    }

    private func matches(_ haystack: String...) -> Bool {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return true }
        return haystack.contains { $0.lowercased().contains(needle) }
    }

    // MARK: - Sections

    @ViewBuilder private func overview(_ kg: KnowledgeGraph) -> some View {
        if let o = kg.overview {
            SectionCard(title: "What this is", systemImage: "info.circle") {
                if let pitch = o.elevatorPitch { Text(pitch).font(.title3) }
                if let purpose = o.purpose { Text(purpose).font(.callout) }
            }

            if let architecture = o.architecture {
                SectionCard(title: "Architecture", systemImage: "building.columns") {
                    Text(architecture).font(.callout)
                }
            }

            HStack(alignment: .top, spacing: 14) {
                if let stack = o.stack, !stack.isEmpty {
                    SectionCard(title: "Stack", systemImage: "square.stack.3d.up") {
                        ForEach(stack) { item in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(item.name).font(.callout).bold()
                                if let v = item.version, !v.isEmpty {
                                    Text(v).font(.caption2).foregroundStyle(.tertiary)
                                }
                                Text(item.role).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let entries = o.entryPoints, !entries.isEmpty {
                    SectionCard(title: "Where execution starts", systemImage: "arrow.right.circle") {
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(entry.path).font(.system(.caption, design: .monospaced))
                                Text(entry.what).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if let commands = o.commands, !commands.pairs.isEmpty {
                SectionCard(title: "Commands", systemImage: "terminal") {
                    ForEach(commands.pairs, id: \.0) { key, value in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(key).font(.caption2).foregroundStyle(.secondary).frame(width: 60, alignment: .leading)
                            Text(value)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                            Spacer()
                            Button {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(value, forType: .string)
                            } label: {
                                Image(systemName: "doc.on.doc").font(.caption2)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }

            HStack(alignment: .top, spacing: 14) {
                if let conventions = o.conventions, !conventions.isEmpty {
                    SectionCard(title: "Conventions", systemImage: "checkmark.seal") {
                        ForEach(conventions, id: \.self) { Text("• \($0)").font(.caption) }
                    }
                }
                if let gotchas = o.gotchas, !gotchas.isEmpty {
                    SectionCard(title: "Gotchas", systemImage: "exclamationmark.triangle") {
                        ForEach(gotchas, id: \.self) { Text("• \($0)").font(.caption) }
                    }
                }
            }

            if let glossary = o.glossary, !glossary.isEmpty {
                SectionCard(title: "Glossary", systemImage: "text.book.closed") {
                    ForEach(glossary) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(item.term).font(.caption).bold()
                            Text(item.meaning).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else {
            Text("The overview has not been written yet.").foregroundStyle(.secondary)
        }
    }

    /// Every traced request path. This is the section a developer opens to answer
    /// "where does this endpoint actually go?", so the chain is the whole point.
    @ViewBuilder private func flows(_ kg: KnowledgeGraph) -> some View {
        let all = (kg.flows ?? []).filter { matches($0.key, $0.entryPath, $0.module ?? "") }
        if all.isEmpty {
            Text("No flows have been traced yet. They are built from the call graph during indexing.")
                .foregroundStyle(.secondary)
        } else {
            let endpoints = all.filter(\.isEndpoint)
            let others = all.filter { !$0.isEndpoint }
            flowGroup("Endpoints", endpoints)
            flowGroup("Jobs, screens and other entry points", others)
        }
    }

    @ViewBuilder private func flowGroup(_ title: String, _ flows: [KGFlow]) -> some View {
        if !flows.isEmpty {
            Text(title).font(.headline).padding(.top, 4)
            ForEach(flows) { flow in
                SectionCard(
                    title: flow.key,
                    subtitle: flow.touches.joined(separator: " → "),
                    systemImage: flow.isEndpoint ? "arrow.right.circle" : "clock.arrow.circlepath"
                ) {
                    Text(flow.entryLocation)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)

                    if flow.steps.isEmpty {
                        Text("Does its work inline — calls nothing else in this repository.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(flow.steps) { step in
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Text(String(repeating: "   ", count: max(0, step.depth - 1)) + "└─")
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                    Text("\(step.name)()")
                                        .font(.system(.caption, design: .monospaced))
                                    if let layer = step.layer { LayerBadge(layer: layer) }
                                    Spacer()
                                    Text(step.location)
                                        .font(.system(size: 9, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                        .textSelection(.enabled)
                                }
                                .help(step.evidence ?? "called at line \(step.callLine)")
                            }
                        }
                    }
                }
            }
        }
    }

    /// Symptom → cause → files to open → fix → verify.
    @ViewBuilder private func playbooks(_ kg: KnowledgeGraph) -> some View {
        let all = kg.playbooks ?? []
        if all.isEmpty {
            Text("No playbooks yet. They are written during a deep knowledge-graph build.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(all) { module in
                let entries = (module.playbooks ?? []).filter { matches($0.symptom, $0.likelyCause) }
                if !entries.isEmpty || !(module.invariants ?? []).isEmpty {
                    SectionCard(title: module.name, systemImage: "stethoscope") {
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(entry.symptom).font(.callout).bold()
                                Text(entry.likelyCause).font(.caption).foregroundStyle(.secondary)
                                if !entry.checkFirst.isEmpty {
                                    labelled("Open these, in order") {
                                        ForEach(Array(entry.checkFirst.enumerated()), id: \.offset) { i, file in
                                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                                Text("\(i + 1).").font(.caption2).foregroundStyle(.tertiary)
                                                Text(file.path).font(.system(.caption2, design: .monospaced))
                                                Text(file.what).font(.caption2).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                                if let fix = entry.fixPattern {
                                    Text("Fix — \(fix)").font(.caption2)
                                }
                                if let verify = entry.verify {
                                    Text("Verify — \(verify)").font(.caption2).foregroundStyle(.green)
                                }
                            }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
                        }
                        if let invariants = module.invariants, !invariants.isEmpty {
                            labelled("Invariants — breaking one of these breaks the module") {
                                ForEach(invariants, id: \.self) {
                                    Text("• \($0)").font(.caption2).foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// The contracts an agent needs before it edits anything.
    @ViewBuilder private func functions(_ kg: KnowledgeGraph) -> some View {
        let all = kg.describedFunctions.filter { matches($0.name, $0.path, $0.purpose ?? "") }
        if all.isEmpty {
            Text("No function contracts yet. They are written during a deep knowledge-graph build.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(all) { fn in
                SectionCard(title: "\(fn.name)(\(fn.params ?? ""))", subtitle: fn.module, systemImage: "function") {
                    HStack(spacing: 8) {
                        Text(fn.location)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                        Text(fn.kind).font(.caption2).foregroundStyle(.secondary)
                        if fn.exported { Text("exported").font(.caption2).foregroundStyle(.green) }
                        Spacer()
                        Text("called by \(fn.calledBy) · calls \(fn.calls)")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let purpose = fn.purpose { Text(purpose).font(.callout) }
                    if let returns = fn.returns, !returns.isEmpty {
                        labelled("Returns") { Text(returns).font(.system(.caption2, design: .monospaced)) }
                    }
                    if !fn.sideEffects.isEmpty {
                        labelled("Changes outside itself") {
                            ForEach(fn.sideEffects, id: \.self) { Text("• \($0)").font(.caption2) }
                        }
                    }
                    if !fn.throws_.isEmpty {
                        labelled("Fails when") {
                            ForEach(fn.throws_, id: \.self) {
                                Text("• \($0)").font(.caption2).foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Paste an error from a log, find the line that raised it.
    @ViewBuilder private func errors(_ kg: KnowledgeGraph) -> some View {
        let all = (kg.errors ?? []).filter { matches($0.label, $0.path, $0.meaning ?? "", $0.symbol ?? "") }
        if all.isEmpty {
            Text("No errors catalogued.").foregroundStyle(.secondary)
        } else {
            Text("\(all.count) failures this codebase can raise. Search above by the text you saw in the log.")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(all) { error in
                SectionCard(title: error.label, subtitle: error.module, systemImage: "exclamationmark.triangle") {
                    HStack(spacing: 8) {
                        Text(error.location)
                            .font(.system(size: 9, design: .monospaced))
                            .textSelection(.enabled)
                        if let symbol = error.symbol {
                            Text("in \(symbol)()").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(error.kind).font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let meaning = error.meaning { Text(meaning).font(.caption) }
                    if let evidence = error.evidence {
                        Text(evidence)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    @ViewBuilder private func modules(_ kg: KnowledgeGraph) -> some View {
        ForEach(kg.modules.filter { matches($0.name, $0.what ?? "") }) { module in
            SectionCard(
                title: module.name,
                subtitle: module.fileCount.map { "\($0) files" },
                systemImage: "shippingbox"
            ) {
                if let what = module.what { Text(what).font(.callout) }

                if let responsibilities = module.responsibilities, !responsibilities.isEmpty {
                    labelled("Owns") {
                        ForEach(responsibilities, id: \.self) { Text("• \($0)").font(.caption) }
                    }
                }
                if let keyFiles = module.keyFiles, !keyFiles.isEmpty {
                    labelled("Read first") {
                        ForEach(keyFiles) { file in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(file.path).font(.system(.caption2, design: .monospaced))
                                Text(file.why).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                HStack(alignment: .top, spacing: 18) {
                    if let dataIn = module.dataIn, !dataIn.isEmpty {
                        labelled("In") { ForEach(dataIn, id: \.self) { Text("• \($0)").font(.caption2) } }
                    }
                    if let dataOut = module.dataOut, !dataOut.isEmpty {
                        labelled("Out") { ForEach(dataOut, id: \.self) { Text("• \($0)").font(.caption2) } }
                    }
                }
                if let extendHere = module.extendHere, !extendHere.isEmpty {
                    labelled("Extend here") {
                        ForEach(extendHere, id: \.self) { Text("• \($0)").font(.caption2) }
                    }
                }
                if let risks = module.risks, !risks.isEmpty {
                    labelled("Do not break") {
                        ForEach(risks, id: \.self) {
                            Text("• \($0)").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func api(_ kg: KnowledgeGraph) -> some View {
        let filtered = kg.endpoints.filter { matches($0.path, $0.method, $0.summary ?? "", $0.handler ?? "") }
        if filtered.isEmpty {
            Text("No endpoints were found in this repository.").foregroundStyle(.secondary)
        } else {
            ForEach(filtered) { endpoint in
                SectionCard(title: "\(endpoint.method) \(endpoint.path)", subtitle: endpoint.module, systemImage: "network") {
                    if let summary = endpoint.summary { Text(summary).font(.callout) }

                    HStack(spacing: 14) {
                        if let handler = endpoint.handler {
                            Label(handler + (endpoint.symbol.map { " → \($0)()" } ?? ""), systemImage: "function")
                                .font(.system(.caption2, design: .monospaced))
                        }
                        if let auth = endpoint.auth, !auth.isEmpty {
                            Label(auth, systemImage: "lock").font(.caption2)
                        }
                        if !endpoint.middleware.isEmpty {
                            Label(endpoint.middleware.joined(separator: " → "), systemImage: "arrow.right.to.line")
                                .font(.caption2)
                        }
                    }
                    .foregroundStyle(.secondary)

                    fields("Path parameters", endpoint.request.pathParams)
                    fields("Query parameters", endpoint.request.queryParams)
                    fields("Request body", endpoint.request.bodyFields)

                    if let success = endpoint.response.success, !success.isEmpty {
                        labelled("Response") {
                            Text(success)
                                .font(.system(.caption2, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                    if let errors = endpoint.response.errors, !errors.isEmpty {
                        labelled("Errors") { ForEach(errors, id: \.self) { Text("• \($0)").font(.caption2) } }
                    }
                    if !endpoint.statusCodes.isEmpty {
                        Text("Status codes: \(endpoint.statusCodes.joined(separator: ", "))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let evidence = endpoint.evidence {
                        Text("Proven by: \(evidence)")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                    }
                }
            }
        }
    }

    @ViewBuilder private func data(_ kg: KnowledgeGraph) -> some View {
        let filtered = kg.entities.filter { matches($0.name, $0.summary ?? "") }
        if filtered.isEmpty {
            Text("No data models were found.").foregroundStyle(.secondary)
        } else {
            ForEach(filtered) { entity in
                SectionCard(title: entity.name, subtitle: entity.store, systemImage: "tablecells") {
                    if let summary = entity.summary { Text(summary).font(.callout) }
                    if let path = entity.filePath {
                        Text(path).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    fieldTable(entity.fields)
                    if !entity.relations.isEmpty {
                        labelled("Relations") {
                            ForEach(entity.relations, id: \.to) { relation in
                                Text("\(relation.kind) **\(relation.to)**" + (relation.via.map { " via `\($0)`" } ?? ""))
                                    .font(.caption2)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func screens(_ kg: KnowledgeGraph) -> some View {
        let filtered = kg.screens.filter { matches($0.name, $0.route ?? "", $0.summary ?? "") }
        if filtered.isEmpty {
            Text("No screens were found.").foregroundStyle(.secondary)
        } else {
            ForEach(filtered) { screen in
                SectionCard(title: screen.name, subtitle: screen.route, systemImage: "macwindow") {
                    if let summary = screen.summary { Text(summary).font(.callout) }
                    if let path = screen.filePath {
                        Text(path).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    }
                    if !screen.calls.isEmpty {
                        labelled("Calls") {
                            ForEach(screen.calls, id: \.self) { call in
                                Text(call).font(.system(.caption2, design: .monospaced))
                            }
                        }
                    }
                    if !screen.components.isEmpty {
                        labelled("Composes") {
                            ForEach(screen.components.prefix(20), id: \.self) { component in
                                Text(component).font(.system(.caption2, design: .monospaced)).lineLimit(1)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func config(_ kg: KnowledgeGraph) -> some View {
        let filtered = kg.env.filter { matches($0.name) }
        SectionCard(title: "Environment variables", subtitle: "\(kg.env.count) read by this codebase", systemImage: "gearshape.2") {
            if filtered.isEmpty {
                Text("None found.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(filtered) { variable in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: variable.required ? "asterisk.circle.fill" : "circle")
                            .font(.system(size: 8))
                            .foregroundStyle(variable.required ? Color.orange : Color.secondary.opacity(0.6))
                            .help(variable.required ? "Declared in the example env file" : "Read in source only")
                        Text(variable.name).font(.system(.caption, design: .monospaced))
                        if let example = variable.example, !example.isEmpty {
                            Text("= \(example)").font(.caption2).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if !variable.usedIn.isEmpty {
                            Text("\(variable.usedIn.count) file\(variable.usedIn.count == 1 ? "" : "s")")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .help(variable.usedIn.prefix(10).joined(separator: "\n"))
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func changes(_ kg: KnowledgeGraph) -> some View {
        if kg.changelog.isEmpty {
            Text("No changes have been recorded yet. The first entry appears after a sync brings in new merges.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(kg.changelog) { entry in
                SectionCard(
                    title: entry.headline ?? entry.title,
                    subtitle: Timestamps.relative(entry.updatedAt),
                    systemImage: "clock.arrow.circlepath"
                ) {
                    if let changes = entry.changes, !changes.isEmpty {
                        ForEach(changes) { change in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                if change.breaking {
                                    Text("BREAKING")
                                        .font(.system(size: 8)).bold()
                                        .padding(.horizontal, 4).padding(.vertical, 1)
                                        .background(.red.opacity(0.2), in: Capsule())
                                }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(change.what).font(.caption)
                                    Text(change.where_).font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    if let impact = entry.agentImpact, !impact.isEmpty {
                        labelled("What an agent must unlearn") {
                            ForEach(impact, id: \.self) {
                                Text("• \($0)").font(.caption2).foregroundStyle(.orange)
                            }
                        }
                    }
                    if let commits = entry.commits, !commits.isEmpty {
                        DisclosureGroup("\(commits.count) merges") {
                            ForEach(commits) { commit in
                                HStack(spacing: 6) {
                                    Text(commit.sha).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                                    Text(commit.subject).font(.caption2).lineLimit(1)
                                }
                            }
                        }
                        .font(.caption)
                    }
                }
            }
        }
    }

    // MARK: - Pieces

    @ViewBuilder private func labelled<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func fields(_ title: String, _ fields: [KGField]?) -> some View {
        if let fields, !fields.isEmpty {
            labelled(title) { fieldTable(fields) }
        }
    }

    @ViewBuilder private func fieldTable(_ fields: [KGField]) -> some View {
        VStack(spacing: 2) {
            ForEach(fields) { field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(field.name)
                        .font(.system(.caption2, design: .monospaced))
                        .frame(width: 150, alignment: .leading)
                    Text(field.type)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: 130, alignment: .leading)
                    if field.required {
                        Text("required").font(.system(size: 9)).foregroundStyle(.orange)
                    }
                    if let note = field.note, !note.isEmpty {
                        Text(note).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Spacer()
                }
            }
        }
    }

    private func copyClaudeMd() {
        Task {
            guard let result: MarkdownResult = try? await detail.markdown() else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(result.markdown, forType: .string)
        }
    }
}

extension RepoDetail {
    /// The agent-facing document, rendered by the engine so the app and the
    /// export bundle can never drift apart.
    func markdown() async throws -> MarkdownResult {
        try await engine.call("kg.claudeMd", ["repoId": repoId])
    }
}
