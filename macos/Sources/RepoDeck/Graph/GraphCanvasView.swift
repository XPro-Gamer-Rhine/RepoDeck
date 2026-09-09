import SwiftUI
import simd

/// The architecture graph, drawn natively.
///
/// One `Canvas` draws every edge and node each frame; the layout that feeds it
/// runs its own simulation (see `GraphLayout`). Pan, zoom, hover and drag are
/// handled here because they are view concerns — the layout only knows graph
/// coordinates and never hears about the viewport.
struct GraphCanvasView: View {
    @ObservedObject var detail: RepoDetail
    @StateObject private var layout = GraphLayout()

    @Environment(\.colorScheme) private var colorScheme

    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var dragStartOffset: CGSize = .zero
    @State private var hoverIndex: Int?
    @State private var edgeColorStore = EdgeColorCache()
    @State private var hoverPoint: CGPoint?
    @State private var draggingIndex: Int?
    @State private var searchText = ""
    @State private var viewportSize: CGSize = .zero
    /// Set once the viewer pans or zooms. After that the auto-fit stops firing:
    /// re-settling the physics should not yank the view away from what someone
    /// deliberately framed.
    @State private var userFramedTheView = false

    // Orbit state, used only by the 3D mode. Yaw spins the cloud about the
    // vertical axis, pitch tips it toward or away from the viewer.
    @State private var yaw: Double = 0.5
    @State private var pitch: Double = -0.25
    @State private var dragStartYaw: Double = 0
    @State private var dragStartPitch: Double = 0

    private var dark: Bool { colorScheme == .dark }

    var body: some View {
        VStack(spacing: 0) {
            controls
            Divider()
            GeometryReader { geo in
                ZStack {
                    canvas(size: geo.size)
                    // A blank canvas gives no clue whether the graph is empty,
                    // filtered to nothing, or still being built.
                    if detail.graph.nodes.isEmpty && !detail.isLoadingGraph {
                        emptyState
                    }
                }
                    .onAppear {
                        viewportSize = geo.size
                        layout.bounds = CGRect(origin: .zero, size: geo.size)
                        reload()
                    }
                    .onChange(of: geo.size) { _, newValue in
                        viewportSize = newValue
                        layout.bounds = CGRect(origin: .zero, size: newValue)
                    }
                    // Comparing counts missed a re-index that produced the same
                    // number of nodes, leaving the previous graph's positions under
                    // the new one's labels.
                    .onChange(of: graphIdentity) { _, _ in reload() }
                    // Fitting at load time frames the seed spiral, not the graph.
                    // The useful moment is when the forces stop moving things.
                    .onChange(of: layout.isSettling) { _, settling in
                        if !settling && !userFramedTheView { fitToWindow() }
                    }
            }
            Divider()
            legend
        }
        .background(background)
    }

    @ViewBuilder private var emptyState: some View {
        // hideTests defaults to true, so a repository of nothing but tests was
        // reported as "nothing indexed at all".
        if detail.graph.meta.visibleFiles == 0
            && detail.minHeat == 0
            && detail.hiddenLayers.isEmpty
            && !detail.hideTests {
            EmptyStateView(
                title: "Nothing indexed yet",
                message: "Run an index and the architecture graph appears here — every file, the imports between them, and a heat channel showing what is changing now.",
                systemImage: "point.3.connected.trianglepath.dotted"
            )
        } else {
            EmptyStateView(
                title: "Every node is filtered out",
                message: "The minimum-heat threshold or the hidden layers are excluding everything in this repository.",
                systemImage: "line.3.horizontal.decrease.circle",
                actionTitle: "Clear filters",
                action: {
                    detail.minHeat = 0
                    detail.hiddenLayers.removeAll()
                    detail.hideTests = false
                }
            )
        }
    }

    private var background: Color {
        dark ? Color(nsColor: .init(white: 0.07, alpha: 1)) : Color(nsColor: .init(white: 0.985, alpha: 1))
    }

    private func reload() {
        let size = viewportSize == .zero ? CGSize(width: 1000, height: 700) : viewportSize
        layout.bounds = CGRect(origin: .zero, size: size)
        userFramedTheView = false
        layout.load(graph: detail.graph, mode: layout.mode)
        // A first fit so the graph is never off-screen while it settles; the
        // real one happens when the simulation stops.
        fitToWindow()
    }

    /// Fit on the next runloop turn, after a layout mode change has repositioned things.
    private func scheduleFit() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { fitToWindow() }
    }

    // MARK: - Toolbar

    /// Menus rather than segmented controls.
    ///
    /// The first version laid four segmented pickers side by side, which needed
    /// roughly 1,400pt of width and simply clipped below that — the window's
    /// own minimum is 1,100. Menus collapse each choice to its current value,
    /// so the row fits at any width the window can actually be.
    private var controls: some View {
        HStack(spacing: 10) {
            Menu {
                Picker("", selection: Binding(get: { detail.grouping }, set: { detail.grouping = $0 })) {
                    Text("Automatic").tag("auto")
                    Text("Functions").tag("symbol")
                    Text("Every file").tag("file")
                    Text("Folders").tag("folder")
                    Text("Features").tag("feature")
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                Label(groupingLabel, systemImage: "square.grid.3x3")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("What one dot stands for")

            Menu {
                Picker("", selection: Binding(get: { layout.mode }, set: { layout.setMode($0); scheduleFit() })) {
                    ForEach(GraphLayout.Mode.allCases) {
                        Text($0.label).tag($0)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                Label(layout.mode.label, systemImage: "point.3.connected.trianglepath.dotted")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("How the nodes are arranged")

            Menu {
                Picker("", selection: $detail.colourBy) {
                    ForEach(RepoDetail.ColourMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } label: {
                Label(detail.colourBy.label, systemImage: "paintpalette")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("What hue means")

            Menu {
                Toggle("Hide tests", isOn: $detail.hideTests)
                Divider()
                Text("Minimum heat")
                Slider(value: $detail.minHeat, in: 0...0.9)
                Button("Show everything") { detail.minHeat = 0; detail.hiddenLayers.removeAll() }
            } label: {
                Label(filterLabel, systemImage: "line.3.horizontal.decrease.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Filters")

            TextField("Search paths, roles, features", text: $searchText)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 140, idealWidth: 220, maxWidth: 320)

            Spacer(minLength: 4)

            if detail.isLoadingGraph {
                ProgressView().controlSize(.small)
            } else if layout.isSettling {
                Text("settling…").font(.caption2).foregroundStyle(.tertiary)
            }

            HStack(spacing: 2) {
                Button { zoom(by: 1 / 1.25) } label: { Image(systemName: "minus.magnifyingglass") }
                    .help("Zoom out")
                Button { fitToWindow() } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .help("Fit to window")
                Button { zoom(by: 1.25) } label: { Image(systemName: "plus.magnifyingglass") }
                    .help("Zoom in")
                Button { layout.reheat(0.9); scheduleFit() } label: { Image(systemName: "arrow.clockwise") }
                    .help("Re-settle the layout")
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    private var groupingLabel: String {
        switch detail.grouping {
        case "symbol": return "Functions"
        case "file": return "Files"
        case "folder": return "Folders"
        case "feature": return "Features"
        default: return detail.graph.grouping == "file" ? "Files" : detail.graph.grouping.capitalized
        }
    }

    private var filterLabel: String {
        var parts: [String] = []
        if detail.hideTests { parts.append("no tests") }
        if detail.minHeat > 0 { parts.append("heat > \(Int(detail.minHeat * 100))%") }
        if !detail.hiddenLayers.isEmpty { parts.append("\(detail.hiddenLayers.count) hidden") }
        return parts.isEmpty ? "Filters" : parts.joined(separator: ", ")
    }

    private func zoom(by factor: CGFloat) {
        userFramedTheView = true
        let centre = CGPoint(x: viewportSize.width / 2, y: viewportSize.height / 2)
        let next = (scale * factor).clamp(to: 0.05...4)
        guard next != scale else { return }
        let graphX = (centre.x - offset.width) / scale
        let graphY = (centre.y - offset.height) / scale
        offset = CGSize(width: centre.x - graphX * next, height: centre.y - graphY * next)
        scale = next
    }

    // MARK: - Canvas

    private func canvas(size: CGSize) -> some View {
        Canvas(rendersAsynchronously: true) { context, _ in
            _ = layout.frame // redraw on every simulation step
            draw(in: &context)
        }
        .contentShape(Rectangle())
        .gesture(dragGesture)
        .onContinuousHover { phase in
            switch phase {
            case .active(let point):
                hoverPoint = point
                hoverIndex = hitTest(at: point)
            case .ended:
                hoverPoint = nil
                hoverIndex = nil
            }
        }
        .onTapGesture { point in
            // Resolve the node NOW, not inside the Task. A reload between the click
            // and the task body would leave the index past the end of a shorter
            // array, which traps.
            guard let index = hitTest(at: point), layout.nodes.indices.contains(index) else {
                Task { await detail.select(node: nil) }
                return
            }
            let node = layout.nodes[index]
            Task { await detail.select(node: node) }
        }
        .modifier(ScrollZoom(scale: $scale, offset: $offset, onManualZoom: { userFramedTheView = true }))
        .onDisappear { releaseDrag() }
        .overlay(alignment: .topLeading) { tooltip }
        .overlay(alignment: .bottomTrailing) { scaleBadge }
    }

    private func draw(in context: inout GraphicsContext) {
        let nodes = layout.nodes
        guard !nodes.isEmpty else { return }

        let focus = focusSet()
        let matches = searchMatches()
        let projected = projectAll()
        guard projected.count == nodes.count else { return }

        // Painter's algorithm: furthest first, so near nodes occlude far ones.
        // In 2D every depth is zero and this collapses to the original order.
        // Only the 3D view needs an explicit order. In 2D every depth is zero, so
        // materialising an index array per frame just to iterate it in order was
        // an allocation the size of the graph, sixty times a second.
        let drawOrder: [Int]? = layout.mode == .orbit
            ? nodes.indices.sorted { projected[$0].depth > projected[$1].depth }
            : nil

        // ── edges ────────────────────────────────────────────────────────────
        // Drawn first and never over a node: at this density an edge crossing a
        // node reads as a scratch on the map.
        //
        // Every edge is directed, because the question the graph exists to
        // answer — where does a request go? — is a question about direction. The
        // line stops at the target's edge and an arrowhead sits there; a bare
        // line would leave the reader guessing which way the call runs.
        // Hoisted out of the loop. `detail` is an observed object, so each access
        // inside the body was a property read on top of the set hashing — and on
        // the overwhelmingly common path nothing is hidden at all, which the
        // isEmpty check settles once instead of twice per edge.
        let hiddenLayers = detail.hiddenLayers
        let anyHidden = !hiddenLayers.isEmpty

        // Edge colour is a function of the source node's hue, which changes only
        // when the colour mode or the graph does — not once per edge per frame,
        // which is what deriving it in the loop amounted to.
        let edgeColors = edgeColorCache(dark: dark)

        for link in layout.links {
            // An edge whose endpoint the legend has hidden was still drawn, leaving
            // arrows pointing at empty space.
            if anyHidden,
               hiddenLayers.contains(nodes[link.a].layer) || hiddenLayers.contains(nodes[link.b].layer) {
                continue
            }

            let dimmed = focus != nil && !(focus!.contains(link.a) && focus!.contains(link.b))
            if dimmed && scale < 0.55 { continue } // too small to read anyway

            let from = projected[link.a].point
            let to = projected[link.b].point
            let targetRadius = projected[link.b].radius
            let edgeDepth = (projected[link.a].depth + projected[link.b].depth) / 2

            var delta = CGSize(width: to.x - from.x, height: to.y - from.y)
            let distance = max(0.001, sqrt(delta.width * delta.width + delta.height * delta.height))
            if distance < targetRadius + 2 { continue } // the two discs are touching
            delta.width /= distance
            delta.height /= distance

            // Stop short of the target so the head lands on its circumference.
            let head = CGPoint(
                x: to.x - delta.width * (targetRadius + 1.5),
                y: to.y - delta.height * (targetRadius + 1.5)
            )

            // Bow the line. A→B and B→A get opposite signs, so a pair of mutual
            // calls reads as two arcs instead of one line drawn twice.
            let bow = curvature(for: link, distance: distance)
            let normal = CGPoint(x: -delta.height, y: delta.width)
            let mid = CGPoint(x: (from.x + head.x) / 2, y: (from.y + head.y) / 2)
            let control = CGPoint(x: mid.x + normal.x * bow, y: mid.y + normal.y * bow)

            var path = Path()
            path.move(to: from)
            path.addQuadCurve(to: head, control: control)

            let base = link.inferred ? edgeColors.inferred[link.a] : edgeColors.solid[link.a]
            var color = base.opacity(depthOpacity(edgeDepth))
            if dimmed { color = color.opacity(0.06) }

            let width = max(0.5, (link.semantic ? 1.5 : 0.9) * scale)
            context.stroke(
                path,
                with: .color(color),
                style: StrokeStyle(
                    lineWidth: width,
                    lineCap: .round,
                    dash: link.inferred ? [3 * scale, 3 * scale] : []
                )
            )

            // The arrowhead points along the curve's final tangent, not the
            // straight line — on a bowed edge those differ enough to look wrong.
            if scale > 0.35 && !dimmed {
                let tangent = normalize(CGPoint(x: head.x - control.x, y: head.y - control.y))
                drawArrowhead(&context, at: head, direction: tangent, size: max(3.5, 5.5 * scale), color: color)
            }

            // Name the relationship, but only inside the neighbourhood being
            // examined — labelling every edge turns the graph into a word cloud.
            if let focus, focus.contains(link.a), focus.contains(link.b), scale > 0.7, link.semantic {
                let label = Text(EdgeVocabulary.label(link.kind))
                    .font(.system(size: max(7, 8 * scale)))
                    .foregroundStyle(dark ? Color.white.opacity(0.65) : Color.black.opacity(0.6))
                let point = CGPoint(x: (mid.x + control.x) / 2, y: (mid.y + control.y) / 2)
                context.draw(label, at: point, anchor: .center)
            }
        }

        // ── nodes ────────────────────────────────────────────────────────────
        for k in nodes.indices {
            // `drawOrder` is nil in 2D, where the natural order is already
            // correct. Indexing through it costs one optional check per node and
            // no allocation; wrapping it in a sequence would box every step.
            let i = drawOrder?[k] ?? k
            let node = nodes[i]
            if detail.hiddenLayers.contains(node.layer) { continue }

            let dimmed = focus != nil && !focus!.contains(i)
            let point = projected[i].point
            let r = projected[i].radius
            if r < 0.4 { continue }

            let (hue, saturation) = hueSaturation(for: node)
            let fill = GraphPalette
                .fill(hue: hue, saturation: saturation, heat: node.heat, dark: dark)
                .opacity(depthOpacity(projected[i].depth))
            let rect = CGRect(x: point.x - r, y: point.y - r, width: r * 2, height: r * 2)

            // The glow is the heat channel doing its second job: a hot node is
            // brighter *and* haloed, which survives being scaled down to 3px.
            if node.heat > 0.25 && !dimmed {
                let glowR = r * (1.6 + node.heat * 1.4)
                let glowRect = CGRect(x: point.x - glowR, y: point.y - glowR, width: glowR * 2, height: glowR * 2)
                context.fill(
                    Path(ellipseIn: glowRect),
                    with: .radialGradient(
                        Gradient(colors: [fill.opacity(0.34 * node.heat), fill.opacity(0)]),
                        center: point,
                        startRadius: r * 0.6,
                        endRadius: glowR
                    )
                )
            }

            let shape = shapePath(for: node.layer, in: rect)
            context.fill(shape, with: .color(dimmed ? fill.opacity(0.14) : fill))

            if matches.contains(i) {
                context.stroke(shape, with: .color(.yellow), lineWidth: max(1.4, 2 * scale))
            } else if detail.selectedNode?.id == node.id {
                context.stroke(shape, with: .color(dark ? .white : .black), lineWidth: max(1.2, 1.8 * scale))
            } else if hoverIndex == i {
                context.stroke(shape, with: .color(dark ? .white.opacity(0.8) : .black.opacity(0.6)), lineWidth: 1.5)
            } else if !dimmed {
                context.stroke(shape, with: .color(.black.opacity(dark ? 0.45 : 0.12)), lineWidth: 0.5)
            }
        }

        // ── labels ───────────────────────────────────────────────────────────
        // Drawn last, in priority order, and only where they fit.
        //
        // Without collision avoidance a dense cluster renders as overlapping
        // text — "HotspotsModal.tsx" printed through "GraphView.tsx" — which is
        // strictly worse than showing neither. So each label claims a rectangle,
        // and a label whose rectangle is already taken is simply not drawn: the
        // important ones win, the rest stay available on hover.
        guard scale > 0.55 else { return }

        var claimed: [CGRect] = []
        claimed.reserveCapacity(48)

        // Ordering labels used to sort every index with a comparator that
        // recomputed both scores on each comparison — 2n log n score evaluations
        // per frame, each doing a set lookup and an optional-string compare. Score
        // once, then sort the scores; and since at most ~70 labels are ever drawn,
        // only the top slice needs to be in order.
        let selectedID = detail.selectedNode?.id
        let hidden = detail.hiddenLayers
        var scored: [(index: Int, score: Double)] = []
        scored.reserveCapacity(nodes.count)
        for i in nodes.indices {
            if !hidden.isEmpty && hidden.contains(nodes[i].layer) { continue }
            var score = Double(nodes[i].degree) + nodes[i].heat * 6
            if matches.contains(i) { score += 1000 }
            if nodes[i].id == selectedID { score += 2000 }
            if hoverIndex == i { score += 3000 }
            scored.append((i, score))
        }
        scored.sort { $0.score > $1.score }

        for (i, _) in scored {
            let node = nodes[i]
            let isFocused = hoverIndex == i || node.id == selectedID || matches.contains(i)
            if let focus, !focus.contains(i), !isFocused { continue }
            if claimed.count > 70 && !isFocused { break }

            if layout.mode == .orbit && projected[i].depth > 0.55 && !isFocused { continue }
            let point = projected[i].point
            // Off-screen labels still cost a rectangle; skip them entirely.
            guard point.x > -80, point.y > -40,
                  point.x < viewportSize.width + 80, point.y < viewportSize.height + 40
            else { continue }

            let fontSize = max(9, min(12.5, 9.5 * scale))
            let width = Double(node.label.count) * fontSize * 0.56
            let r = projected[i].radius
            let rect = CGRect(
                x: point.x - width / 2 - 2,
                y: point.y + r + 3,
                width: width + 4,
                height: fontSize + 3
            )

            // A focused label always wins; it displaces nothing but is drawn regardless.
            if !isFocused && claimed.contains(where: { $0.intersects(rect) }) { continue }
            claimed.append(rect)

            let text = Text(node.label)
                .font(.system(size: fontSize, weight: isFocused ? .semibold : .regular))
                .foregroundStyle(dark ? Color.white.opacity(0.92) : Color.black.opacity(0.88))

            // A backing plate keeps a label readable where it crosses an edge.
            if isFocused {
                context.fill(
                    Path(roundedRect: rect, cornerRadius: 3),
                    with: .color(dark ? .black.opacity(0.55) : .white.opacity(0.75))
                )
            }
            context.draw(text, at: CGPoint(x: point.x, y: point.y + r + 4), anchor: .top)
        }
    }

    /// Who gets a label when they cannot all have one: whatever you are pointing
    /// at, then what you searched for, then hubs, then hot files.
    private func labelPriority(_ node: GraphNode, index: Int, matches: Set<Int>) -> Double {
        var score = Double(node.degree) + node.heat * 6
        if matches.contains(index) { score += 1000 }
        if detail.selectedNode?.id == node.id { score += 2000 }
        if hoverIndex == index { score += 3000 }
        return score
    }

    /// One node's position on screen, its drawn radius, and how far away it is.
    ///
    /// In every 2D mode this is the identity plus pan/zoom. In orbit mode the
    /// cloud is rotated about its own centre and projected with perspective, so
    /// nearer nodes are larger and further ones recede — which is the whole
    /// reason to have a third dimension at all.
    private struct Projected {
        var point: CGPoint
        var radius: CGFloat
        var depth: Double      // 0 nearest, 1 furthest
        var visible: Bool
    }

    private func projectAll() -> [Projected] {
        let count = layout.nodes.count
        guard count > 0, layout.radius.count >= count else { return [] }

        if layout.mode != .orbit {
            return (0..<count).map { i in
                Projected(
                    point: toView(layout.position[i]),
                    radius: layout.radius[i] * scale,
                    depth: 0,
                    visible: true
                )
            }
        }

        let bounds = layout.cloudBounds()
        let centre = bounds.centre
        let radius = bounds.radius
        // Camera far enough back that the cloud fills the frame without the
        // near nodes ballooning; 2.6 radii is the value that looked right across
        // graphs from thirty nodes to two thousand.
        let cameraDistance = radius * 2.6

        let cosYaw = cos(yaw), sinYaw = sin(yaw)
        let cosPitch = cos(pitch), sinPitch = sin(pitch)

        var out: [Projected] = []
        out.reserveCapacity(count)
        var nearest = Double.infinity
        var furthest = -Double.infinity
        var raw: [(CGPoint, Double, CGFloat)] = []
        raw.reserveCapacity(count)

        for i in 0..<count {
            let x = layout.position[i].x - centre.x
            let y = layout.position[i].y - centre.y
            let z = (i < layout.depth.count ? layout.depth[i] : 0) - centre.z

            // Yaw about Y, then pitch about X.
            let x1 = x * cosYaw + z * sinYaw
            let z1 = -x * sinYaw + z * cosYaw
            let y2 = y * cosPitch - z1 * sinPitch
            let z2 = y * sinPitch + z1 * cosPitch

            let viewZ = z2 + cameraDistance
            nearest = min(nearest, viewZ)
            furthest = max(furthest, viewZ)

            // Perspective divide. The guard keeps a node that drifts behind the
            // camera from projecting to a wild coordinate instead of vanishing.
            let safeZ = max(cameraDistance * 0.25, viewZ)
            let k = cameraDistance / safeZ
            raw.append((CGPoint(x: x1 * k, y: y2 * k), viewZ, CGFloat(k)))
        }

        let span = max(1, furthest - nearest)
        for (i, (point, viewZ, k)) in raw.enumerated() {
            let nodeRadius = i < layout.radius.count ? layout.radius[i] : 0
            out.append(
                Projected(
                    point: CGPoint(
                        x: point.x * scale + offset.width,
                        y: point.y * scale + offset.height
                    ),
                    // Degree still sets the base size — perspective only modulates
                    // it, so a hub stays a hub wherever it happens to be standing.
                    radius: max(0.6, nodeRadius * scale * k),
                    depth: (viewZ - nearest) / span,
                    visible: true
                )
            )
        }
        return out
    }

    /// Nearer nodes are drawn brighter; distance is the only cue the eye gets
    /// once everything is the same colour.
    private func depthOpacity(_ depth: Double) -> Double {
        layout.mode == .orbit ? 1.0 - 0.62 * depth : 1.0
    }

    /// Where a screen point lands in graph space, for the node being dragged.
    ///
    /// In 2D this is the plain inverse of pan and zoom. In 3D a screen point is a
    /// ray, not a point, so the node moves on the viewer-facing plane through its
    /// own depth — the only reading of a flat drag that keeps the node under the
    /// pointer.
    private func graphPoint(from screen: CGPoint, forNode index: Int) -> CGPoint {
        guard layout.mode == .orbit,
              layout.depth.indices.contains(index),
              layout.position.indices.contains(index)
        else { return toGraph(screen) }

        let bounds = layout.cloudBounds()
        let cameraDistance = bounds.radius * 2.6
        let cosYaw = cos(yaw), sinYaw = sin(yaw)
        let cosPitch = cos(pitch), sinPitch = sin(pitch)

        // Forward-project the node to recover the perspective factor it is drawn at.
        let x = layout.position[index].x - bounds.centre.x
        let y = layout.position[index].y - bounds.centre.y
        let z = layout.depth[index] - bounds.centre.z
        let z1 = -x * sinYaw + z * cosYaw
        let z2 = y * sinPitch + z1 * cosPitch
        let k = cameraDistance / max(cameraDistance * 0.25, z2 + cameraDistance)

        // Undo pan, zoom and that factor to get rotated view coordinates.
        let vx = (Double(screen.x) - Double(offset.width)) / Double(scale) / k
        let vy = (Double(screen.y) - Double(offset.height)) / Double(scale) / k

        // Then undo the rotation, holding this node's depth constant.
        let y1 = vy * cosPitch + z2 * sinPitch
        let worldX = vx * cosYaw - z1 * sinYaw
        return CGPoint(x: worldX + bounds.centre.x, y: y1 + bounds.centre.y)
    }

    /// Ends a drag. Also called when the canvas disappears: a gesture cancelled by
    /// a window change never delivers onEnded, and the node stayed pinned,
    /// hijacking every later drag.
    private func releaseDrag() {
        if let index = draggingIndex, index >= 0 { layout.unpin(index) }
        draggingIndex = nil
    }

    /// Cheap identity for "is this a different graph?".
    private var graphIdentity: String {
        let nodes = detail.graph.nodes
        return "\(detail.graph.grouping)|\(nodes.count)|\(nodes.first?.id ?? "")|\(nodes.last?.id ?? "")"
    }

    private func normalize(_ p: CGPoint) -> CGPoint {
        let length = max(0.001, sqrt(p.x * p.x + p.y * p.y))
        return CGPoint(x: p.x / length, y: p.y / length)
    }

    /// How much to bow an edge.
    ///
    /// Zero would be fine if graphs were trees. They are not: mutual calls and
    /// parallel relationships stack exactly on top of each other, and three
    /// edges drawn along one line look like one edge. The sign is derived from
    /// the endpoint order so both directions of a pair curve away from each other.
    private func curvature(
        for link: (a: Int, b: Int, weight: Double, inferred: Bool, semantic: Bool, kind: String),
        distance: CGFloat
    ) -> CGFloat {
        // A flow layout is read column by column; strong bowing there fights the
        // left-to-right reading and buys nothing, since columns rarely double back.
        let base: CGFloat = layout.mode == .flow ? 0.06 : 0.14
        let direction: CGFloat = link.a < link.b ? 1 : -1
        return base * direction * min(1, distance / 400)
    }

    private func drawArrowhead(
        _ context: inout GraphicsContext,
        at point: CGPoint,
        direction: CGPoint,
        size: CGFloat,
        color: Color
    ) {
        let back = CGPoint(x: -direction.x, y: -direction.y)
        let normal = CGPoint(x: -direction.y, y: direction.x)
        var head = Path()
        head.move(to: point)
        head.addLine(to: CGPoint(
            x: point.x + back.x * size + normal.x * size * 0.45,
            y: point.y + back.y * size + normal.y * size * 0.45
        ))
        head.addLine(to: CGPoint(
            x: point.x + back.x * size - normal.x * size * 0.45,
            y: point.y + back.y * size - normal.y * size * 0.45
        ))
        head.closeSubpath()
        context.fill(head, with: .color(color.opacity(0.95)))
    }

    /// Shape carries layer as a second, colour-blind-safe channel.
    private func shapePath(for layer: String, in rect: CGRect) -> Path {
        switch layer {
        case "route": return diamond(in: rect)
        case "middleware": return polygon(sides: 6, in: rect)
        case "engine": return polygon(sides: 8, in: rect)
        case "model": return Path(roundedRect: rect, cornerRadius: rect.width * 0.22)
        case "job": return polygon(sides: 3, in: rect)
        default: return Path(ellipseIn: rect)
        }
    }

    private func diamond(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        p.closeSubpath()
        return p
    }

    private func polygon(sides: Int, in rect: CGRect) -> Path {
        var p = Path()
        let r = rect.width / 2
        let c = CGPoint(x: rect.midX, y: rect.midY)
        for i in 0..<sides {
            let angle = 2 * .pi * Double(i) / Double(sides) - .pi / 2
            let point = CGPoint(x: c.x + r * cos(angle), y: c.y + r * sin(angle))
            if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
        }
        p.closeSubpath()
        return p
    }

    /// Above a few hundred nodes, labelling everything is labelling nothing.
    private func labelDegreeThreshold() -> Int {
        switch layout.nodes.count {
        case 0..<80: return 0
        case 80..<250: return 2
        case 250..<600: return 4
        default: return 8
        }
    }

    // MARK: - Focus and search

    /// Hovering a node blurs everything outside its neighbourhood, which is the
    /// single most useful thing you can do to a dense graph.
    private func focusSet() -> Set<Int>? {
        var anchor: Int?
        if let hoverIndex { anchor = hoverIndex }
        else if let selected = detail.selectedNode, let i = layout.indexOf[selected.id] { anchor = i }
        guard let anchor else { return nil }
        var set = layout.neighbours(of: anchor)
        set.insert(anchor)
        return set
    }

    /// Indices whose path, module or role contain the search text.
    ///
    /// Called from the draw path, so it runs on every frame of the simulation —
    /// with three `lowercased()` allocations per node it was the single largest
    /// source of per-frame garbage on a large graph. The lowercased haystack is
    /// built once per node when the layout loads; this only scans it.
    private func searchMatches() -> Set<Int> {
        let needle = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard needle.count >= 2 else { return [] }
        var out = Set<Int>()
        let keys = layout.searchKeys
        guard keys.count == layout.nodes.count else { return [] }
        for i in keys.indices where keys[i].contains(needle) { out.insert(i) }
        return out
    }

    /// Per-node edge colours, in both solid and inferred variants.
    ///
    /// Rebuilt only when the node set, the colour mode or the appearance changes.
    /// Constructing a SwiftUI `Color` per edge per frame showed up as real cost
    /// on a graph of a few thousand edges, and the value is identical every time.
    /// A reference type on purpose: the Canvas draw closure is non-mutating, so
    /// a value-typed cache could not be filled from inside it.
    final class EdgeColorCache {
        var solid: [Color] = []
        var inferred: [Color] = []
        var signature: String = ""
    }

    private func edgeColorCache(dark: Bool) -> EdgeColorCache {
        let signature = "\(layout.nodes.count)|\(detail.colourBy.rawValue)|\(dark)"
        let cache = edgeColorStore
        if cache.signature == signature { return cache }

        var solid: [Color] = []
        var inferred: [Color] = []
        solid.reserveCapacity(layout.nodes.count)
        inferred.reserveCapacity(layout.nodes.count)
        for node in layout.nodes {
            let (hue, _) = hueSaturation(for: node)
            solid.append(GraphPalette.edgeColor(hue: hue, inferred: false, dark: dark))
            inferred.append(GraphPalette.edgeColor(hue: hue, inferred: true, dark: dark))
        }
        cache.solid = solid
        cache.inferred = inferred
        cache.signature = signature
        return cache
    }

    private func hueSaturation(for node: GraphNode) -> (Double, Double) {
        switch detail.colourBy {
        case .layer:
            return GraphPalette.hueAndSaturation(for: node.layer)
        case .folder:
            return (GraphPalette.hue(forKey: node.folder ?? node.path), 0.62)
        case .feature:
            return (GraphPalette.hue(forKey: node.module ?? "unassigned"), 0.66)
        case .cluster:
            return (GraphPalette.hue(forCluster: node.cluster), node.cluster < 0 ? 0.10 : 0.66)
        }
    }

    // MARK: - Overlays

    @ViewBuilder private var tooltip: some View {
        if let hoverIndex, let hoverPoint, layout.nodes.indices.contains(hoverIndex) {
            let node = layout.nodes[hoverIndex]
            VStack(alignment: .leading, spacing: 3) {
                Text(node.path).font(.system(.caption, design: .monospaced)).bold()
                if let role = node.role, !role.isEmpty {
                    Text(role).font(.caption2).foregroundStyle(.secondary)
                }
                if let summary = node.summary, !summary.isEmpty {
                    Text(summary).font(.caption2).frame(maxWidth: 320, alignment: .leading)
                }
                HStack(spacing: 8) {
                    Label(GraphPalette.layerLabel(node.layer), systemImage: "square.fill")
                        .foregroundStyle(GraphPalette.color(for: node.layer, dark: dark))
                    if let module = node.module { Text(module) }
                    Text("\(node.merges) merges")
                    Text("\(node.churn) lines")
                    Text("\(node.degree) links")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)

                // Computed once. This walks every edge in the graph, and the
                // tooltip's body re-evaluates on every simulation frame.
                let wiring = namedRelationships(of: node).prefix(3)
                if !wiring.isEmpty {
                    Text(wiring.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.tint)
                }
            }
            .padding(8)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7))
            .shadow(radius: 8)
            .offset(x: min(hoverPoint.x + 14, max(0, viewportSize.width - 340)),
                    y: min(hoverPoint.y + 14, max(0, viewportSize.height - 120)))
            .allowsHitTesting(false)
        }
    }

    /// The wiring this node takes part in, beyond plain imports — the reason
    /// most people are looking at it.
    private func namedRelationships(of node: GraphNode) -> [String] {
        var out: [String] = []
        for edge in detail.graph.edges {
            guard edge.kind != "import" else { continue }
            if edge.from == node.id {
                out.append("\(EdgeVocabulary.label(edge.kind)) \(shortName(edge.to))")
            } else if edge.to == node.id {
                out.append("\(shortName(edge.from)) \(EdgeVocabulary.label(edge.kind)) this")
            }
            // Only the first three are shown; there is no reason to build the rest.
            if out.count == 3 { break }
        }
        return out
    }

    private func shortName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private var scaleBadge: some View {
        Text("\(layout.nodes.count) nodes · \(layout.links.count) edges · \(Int(scale * 100))%")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(6)
    }

    // MARK: - Legend

    private var legend: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(detail.graph.meta.layers, id: \.layer) { entry in
                    let hidden = detail.hiddenLayers.contains(entry.layer)
                    Button {
                        if hidden { detail.hiddenLayers.remove(entry.layer) }
                        else { detail.hiddenLayers.insert(entry.layer) }
                    } label: {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(GraphPalette.color(for: entry.layer, dark: dark))
                                .frame(width: 9, height: 9)
                            Text(GraphPalette.layerLabel(entry.layer))
                            Text("\(entry.count)").foregroundStyle(.tertiary)
                        }
                        .font(.caption)
                        .opacity(hidden ? 0.35 : 1)
                    }
                    .buttonStyle(.plain)
                    .help(hidden ? "Show \(entry.layer)" : "Hide \(entry.layer)")
                }

                Divider().frame(height: 14)

                HStack(spacing: 4) {
                    Text("cold").font(.caption2).foregroundStyle(.tertiary)
                    ForEach(0..<8) { i in
                        Rectangle()
                            .fill(GraphPalette.heatColor(Double(i) / 7, dark: dark))
                            .frame(width: 12, height: 8)
                    }
                    Text("hot").font(.caption2).foregroundStyle(.tertiary)
                }
                .help("Brightness and glow track time-decayed merge churn")

                Divider().frame(height: 14)

                HStack(spacing: 4) {
                    Rectangle().fill(.secondary).frame(width: 16, height: 1)
                    Text("import").font(.caption2)
                    Rectangle().fill(.secondary).frame(width: 16, height: 1).opacity(0.5)
                    Text("inferred").font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
        }
    }

    // MARK: - Viewport

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                if draggingIndex == nil {
                    // Decide once, on the first movement: a node under the pointer
                    // means "move this node"; empty space means pan — or, in the
                    // 3D view, orbit, because rotating the cloud is the primary
                    // way you read depth and panning is the rarer intent.
                    if let hit = hitTest(at: value.startLocation) {
                        draggingIndex = hit
                    } else {
                        draggingIndex = -1
                        dragStartOffset = offset
                        dragStartYaw = yaw
                        dragStartPitch = pitch
                    }
                }

                if let index = draggingIndex, index >= 0 {
                    // `toGraph` inverts the 2D pan and zoom only. Using it in the
                    // 3D view ignored the rotation and the perspective divide, so
                    // grabbing a node teleported it out of the cloud.
                    layout.pin(index, at: graphPoint(from: value.location, forNode: index))
                } else if layout.mode == .orbit {
                    yaw = dragStartYaw + Double(value.translation.width) * 0.006
                    // Clamped just short of the poles: past vertical the cloud
                    // flips and the gesture inverts under your hand.
                    pitch = (dragStartPitch - Double(value.translation.height) * 0.006)
                        .clamp(to: -1.45...1.45)
                } else {
                    offset = CGSize(
                        width: dragStartOffset.width + value.translation.width,
                        height: dragStartOffset.height + value.translation.height
                    )
                    userFramedTheView = true
                }
            }
            .onEnded { _ in
                releaseDrag()
            }
    }

    /// Hit testing against what is on screen.
    ///
    /// In 2D the layout can answer this in graph coordinates. In 3D it cannot —
    /// the node nearest the pointer in space is not the one nearest on screen —
    /// so the test runs against the projection, and ties go to whichever node is
    /// closer to the camera.
    private func hitTest(at point: CGPoint) -> Int? {
        if layout.mode != .orbit { return layout.hitTest(toGraph(point)) }

        // Hover fires at pointer rate. Building the full projection array here
        // allocated a new array of every node on every mouse move; this walks the
        // same maths without allocating and keeps only the best candidate.
        let count = layout.nodes.count
        guard count > 0, layout.radius.count >= count, layout.depth.count >= count else { return nil }

        let bounds = layout.cloudBounds()
        let cameraDistance = bounds.radius * 2.6
        let cosYaw = cos(yaw), sinYaw = sin(yaw)
        let cosPitch = cos(pitch), sinPitch = sin(pitch)

        var best: Int?
        var bestViewZ = Double.infinity

        for i in 0..<count {
            let x = layout.position[i].x - bounds.centre.x
            let y = layout.position[i].y - bounds.centre.y
            let z = layout.depth[i] - bounds.centre.z

            let x1 = x * cosYaw + z * sinYaw
            let z1 = -x * sinYaw + z * cosYaw
            let y2 = y * cosPitch - z1 * sinPitch
            let z2 = y * sinPitch + z1 * cosPitch

            let viewZ = z2 + cameraDistance
            let k = cameraDistance / max(cameraDistance * 0.25, viewZ)

            let sx = x1 * k * Double(scale) + Double(offset.width)
            let sy = y2 * k * Double(scale) + Double(offset.height)
            let r = max(0.6, layout.radius[i] * Double(scale) * k)

            // A hidden node is not on screen; hovering, selecting or dragging one
            // the legend has filtered out is indistinguishable from a bug.
            if detail.hiddenLayers.contains(layout.nodes[i].layer) { continue }
            let dx = sx - Double(point.x)
            let dy = sy - Double(point.y)
            guard (dx * dx + dy * dy).squareRoot() <= r + 5 else { continue }
            // Nearest to the camera wins, which is the one drawn on top.
            if viewZ < bestViewZ {
                best = i
                bestViewZ = viewZ
            }
        }
        return best
    }

    private func toView(_ p: SIMD2<Double>) -> CGPoint {
        CGPoint(x: p.x * scale + offset.width, y: p.y * scale + offset.height)
    }

    private func toGraph(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - offset.width) / scale, y: (p.y - offset.height) / scale)
    }

    private func fitToWindow() {
        guard viewportSize.width > 10, !layout.nodes.isEmpty else { return }
        userFramedTheView = false

        if layout.mode == .orbit {
            // The projection already centres the cloud on the origin, so fitting
            // is only a matter of scale and putting the origin in the middle.
            let radius = layout.contentRadius()
            let fit = min(viewportSize.width, viewportSize.height) / 2 - 50
            scale = max(0.05, min(3, fit / max(1, radius)))
            offset = CGSize(width: viewportSize.width / 2, height: viewportSize.height / 2)
            return
        }
        let content = layout.contentBounds()
        let padding: CGFloat = 40
        let sx = (viewportSize.width - padding * 2) / max(1, content.width)
        let sy = (viewportSize.height - padding * 2) / max(1, content.height)
        let newScale = min(3, max(0.05, min(sx, sy)))
        scale = newScale
        offset = CGSize(
            width: viewportSize.width / 2 - content.midX * newScale,
            height: viewportSize.height / 2 - content.midY * newScale
        )
    }
}

/// Scroll to zoom around the pointer, the way every map does.
///
/// SwiftUI has no scroll-wheel gesture on macOS, so this drops an `NSView` into
/// the hierarchy purely to receive `scrollWheel` and `magnify`. Zooming about
/// the cursor rather than the view centre is what makes a dense graph navigable:
/// you point at the cluster you care about and it grows under the pointer.
private struct ScrollZoom: ViewModifier {
    @Binding var scale: CGFloat
    @Binding var offset: CGSize
    let onManualZoom: () -> Void

    func body(content: Content) -> some View {
        content.overlay(
            ZoomCatcher { delta, location in
                zoom(by: delta, around: location)
            }
        )
    }

    private func zoom(by factor: CGFloat, around point: CGPoint) {
        let next = (scale * factor).clamp(to: 0.05...4)
        guard next != scale else { return }
        onManualZoom()
        // Keep the graph point under the cursor fixed: solve for the offset that
        // maps the same graph coordinate to the same view coordinate at the new scale.
        let graphX = (point.x - offset.width) / scale
        let graphY = (point.y - offset.height) / scale
        offset = CGSize(width: point.x - graphX * next, height: point.y - graphY * next)
        scale = next
    }
}

private struct ZoomCatcher: NSViewRepresentable {
    let onZoom: (CGFloat, CGPoint) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onZoom = onZoom
        return view
    }

    func updateNSView(_ nsView: CatcherView, context: Context) {
        nsView.onZoom = onZoom
    }

    /// Watches for scroll and pinch over the canvas without taking part in hit testing.
    ///
    /// `hitTest` returns nil so clicks and drags reach the SwiftUI gestures
    /// underneath — which also takes this view out of the path AppKit uses to
    /// route scroll and pinch, so the responder overrides below cannot be relied
    /// on to fire. A local event monitor reads those events before dispatch,
    /// filtered to the ones landing inside these bounds.
    ///
    /// Both paths are kept deliberately. The monitor consumes what it handles,
    /// so the overrides can never double-apply a zoom; they simply remain as the
    /// fallback if the monitor is ever not installed.
    final class CatcherView: NSView {
        var onZoom: ((CGFloat, CGPoint) -> Void)?
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func scrollWheel(with event: NSEvent) {
            let raw = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY / 220 : event.scrollingDeltaY / 12
            guard raw != 0 else { return }
            emit(factor: 1 + raw, at: event)
        }

        override func magnify(with event: NSEvent) {
            guard event.magnification != 0 else { return }
            emit(factor: 1 + event.magnification, at: event)
        }

        private func emit(factor: CGFloat, at event: NSEvent) {
            let local = convert(event.locationInWindow, from: nil)
            // AppKit's origin is bottom-left; SwiftUI's is top-left.
            onZoom?(factor, CGPoint(x: local.x, y: bounds.height - local.y))
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else {
                removeMonitor()
                return
            }
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .magnify]) { [weak self] event in
                guard let self, let window = self.window, event.window === window else { return event }
                let local = self.convert(event.locationInWindow, from: nil)
                guard self.bounds.contains(local) else { return event }

                let factor: CGFloat
                if event.type == .magnify {
                    guard event.magnification != 0 else { return event }
                    factor = 1 + event.magnification
                } else {
                    let raw = event.hasPreciseScrollingDeltas
                        ? event.scrollingDeltaY / 220
                        : event.scrollingDeltaY / 12
                    guard raw != 0 else { return event }
                    factor = 1 + raw
                }

                // AppKit's origin is bottom-left; SwiftUI's is top-left.
                self.onZoom?(factor, CGPoint(x: local.x, y: self.bounds.height - local.y))
                return nil // consumed
            }
        }

        private func removeMonitor() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }

        deinit { removeMonitor() }
    }
}
