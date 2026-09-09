import Foundation
import SwiftUI
import simd

/// A force-directed layout over the repository graph.
///
/// The physics is the familiar three-force model — many-body repulsion, spring
/// attraction along edges, a weak pull to the centre — with one change that
/// matters at repo scale: repulsion is computed through a uniform spatial grid
/// rather than every pair. A 2,000-node graph is four million pairs a frame
/// naively, and about eighty thousand through the grid, which is the difference
/// between a slideshow and a live simulation.
///
/// Positions live in flat arrays rather than an array of node structs so the
/// hot loop stays cache-friendly and free of retain traffic.
@MainActor
final class GraphLayout: ObservableObject {
    /// Bumped once per simulation step; the Canvas redraws on it.
    @Published private(set) var frame: Int = 0
    @Published private(set) var isSettling = false

    enum Mode: String, CaseIterable, Identifiable {
        case force, orbit, flow, circular, grid
        var id: String { rawValue }
        var label: String {
            switch self {
            case .force: return "Force"
            case .orbit: return "3D"
            case .flow: return "Flow"
            case .circular: return "Circular"
            case .grid: return "Grid"
            }
        }

        var blurb: String {
            switch self {
            case .force: return "Physics — clusters emerge from the connections"
            case .orbit: return "The same physics in three dimensions — drag to orbit"
            case .flow: return "Left to right: screen → route → middleware → controller → service → model"
            case .circular: return "Everything on a ring; cross-cutting links read as chords"
            case .grid: return "Hottest first, in reading order"
            }
        }
    }

    private(set) var mode: Mode =
        Mode(rawValue: ProcessInfo.processInfo.environment["REPODECK_LAYOUT"] ?? "") ?? .force

    // Node state, parallel arrays indexed the same as `nodes`.
    private(set) var nodes: [GraphNode] = []
    private(set) var position: [SIMD2<Double>] = []
    private var velocity: [SIMD2<Double>] = []

    /// The third axis, used only by the orbit mode.
    ///
    /// Kept as a parallel array rather than widening `position` to SIMD3: every
    /// other layout is genuinely two-dimensional, and paying for a z component
    /// in the 2D hot loops to serve one mode is the wrong trade.
    private(set) var depth: [Double] = []
    private var depthVelocity: [Double] = []

    var isThreeDimensional: Bool { mode == .orbit }
    private(set) var radius: [Double] = []
    private var pinned: [Bool] = []
    private(set) var indexOf: [String: Int] = [:]

    /// Edges as index pairs, resolved once instead of by dictionary lookup per frame.
    private(set) var links: [(a: Int, b: Int, weight: Double, inferred: Bool, semantic: Bool, kind: String)] = []
    private(set) var adjacency: [Set<Int>] = []

    private var alpha: Double = 1
    private var alphaTarget: Double = 0
    private let alphaDecay = 0.0228
    private let alphaMin = 0.004
    private var timer: Timer?

    // Tunables.
    //
    // The first pass at these produced a tight ball: repulsion was far too weak
    // against the centering pull, so thirty nodes piled into a blob a couple of
    // hundred points across and their labels sat on top of each other. Pushing
    // repulsion up an order of magnitude and easing the centre off gives the
    // graph room to say something about its own shape.
    private var repulsion: Double = 1400
    private var linkDistance: Double = 78
    private var centerPull: Double = 0.016
    private var damping: Double = 0.62

    var bounds: CGRect = CGRect(x: 0, y: 0, width: 1200, height: 800)

    // The simulation is all Double; converting once here keeps CGFloat out of
    // the hot loops, where mixing the two makes the type checker crawl.
    private var minX: Double { Double(bounds.minX) }
    private var minY: Double { Double(bounds.minY) }
    private var midX: Double { Double(bounds.midX) }
    private var midY: Double { Double(bounds.midY) }
    private var width: Double { Double(bounds.width) }
    private var height: Double { Double(bounds.height) }

    deinit { timer?.invalidate() }

    // MARK: - Loading

    func load(graph: GraphData, mode: Mode = .force) {
        stop()
        self.mode = mode
        nodes = graph.nodes
        indexOf = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($1.id, $0) })

        let count = nodes.count
        position = Array(repeating: .zero, count: count)
        velocity = Array(repeating: .zero, count: count)
        depth = Array(repeating: 0, count: count)
        depthVelocity = Array(repeating: 0, count: count)
        pinned = Array(repeating: false, count: count)
        radius = nodes.map { Self.nodeRadius(for: $0) }
        adjacency = Array(repeating: [], count: count)

        links = graph.edges.compactMap { edge in
            guard let a = indexOf[edge.from], let b = indexOf[edge.to], a != b else { return nil }
            adjacency[a].insert(b)
            adjacency[b].insert(a)
            return (a, b, edge.weight, edge.inferred, edge.isSemantic, edge.kind)
        }

        // Density-aware tuning: a big graph needs shorter links and weaker
        // repulsion or it flies apart faster than it settles.
        let scale = max(1.0, Double(count) / 120.0)
        repulsion = 1400 / pow(scale, 0.55)
        linkDistance = max(30, 78 / pow(scale, 0.28))
        centerPull = 0.016 * pow(scale, 0.35)

        seedPositions()
        if mode == .force || mode == .orbit {
            alpha = 1
            start()
        } else {
            frame += 1
        }
    }

    private static func nodeRadius(for node: GraphNode) -> Double {
        // Degree drives size, so hubs read as hubs. sqrt keeps a 200-edge file
        // from being fifty times the area of a two-edge one.
        let base = 3.2 + sqrt(Double(max(node.degree, 0))) * 2.1
        let heatBonus = node.heat * 1.6
        return min(26, base + heatBonus)
    }

    /// Deterministic seeding — a phyllotaxis spiral, the same one d3 uses. Random
    /// seeds make the same repository settle differently every time it is opened,
    /// which destroys any sense of a stable map.
    private func seedPositions() {
        let cx = midX
        let cy = midY

        switch mode {
        case .force:
            for i in 0..<nodes.count {
                let r = 20.0 * sqrt(Double(i) + 0.5)
                let theta = Double(i) * Double.pi * (3.0 - 5.0.squareRoot())
                position[i] = SIMD2(cx + r * cos(theta), cy + r * sin(theta))
            }
        case .orbit:
            // A Fibonacci sphere: evenly spread on a shell, deterministic, and
            // with no seam or pole clustering — so the first frame already looks
            // like a graph in space rather than a disc that has yet to inflate.
            let count = max(1, nodes.count)
            let radius = min(width, height) * 0.34
            let golden = Double.pi * (3.0 - 5.0.squareRoot())
            for i in 0..<nodes.count {
                let y = 1.0 - (Double(i) / Double(max(1, count - 1))) * 2.0
                let ringRadius = max(0.0001, (1 - y * y).squareRoot())
                let theta = golden * Double(i)
                position[i] = SIMD2(
                    cx + radius * cos(theta) * ringRadius,
                    cy + radius * y
                )
                depth[i] = radius * sin(theta) * ringRadius
            }
        case .flow:
            layOutFlow()
        case .circular:
            layOutCircular()
        case .grid:
            layOutGrid()
        }
        velocity = Array(repeating: .zero, count: nodes.count)
        depthVelocity = Array(repeating: 0, count: nodes.count)
        if mode != .orbit { depth = Array(repeating: 0, count: nodes.count) }
    }

    /// Every node on a ring, ordered by layer then module, so cross-cutting
    /// dependencies show up as chords across the middle.
    private func layOutCircular() {
        let order = nodes.indices.sorted { a, b in
            let la = GraphPalette.layerOrder.firstIndex(of: nodes[a].layer) ?? 99
            let lb = GraphPalette.layerOrder.firstIndex(of: nodes[b].layer) ?? 99
            if la != lb { return la < lb }
            let ma = nodes[a].module ?? ""
            let mb = nodes[b].module ?? ""
            if ma != mb { return ma < mb }
            return nodes[a].id < nodes[b].id
        }
        let r = min(width, height) * 0.40
        let centreX = midX
        let centreY = midY
        for (slot, i) in order.enumerated() {
            let theta = 2 * Double.pi * Double(slot) / Double(max(1, order.count)) - Double.pi / 2
            position[i] = SIMD2(centreX + r * cos(theta), centreY + r * sin(theta))
        }
    }

    /// The flow view: columns by architectural role, left to right.
    ///
    /// This is the layout that answers the question the team actually asks —
    /// where does a request go? Physics cannot answer it, because physics has no
    /// notion of upstream and downstream. Columns come from each node's role;
    /// the order *within* a column is solved by repeatedly moving each node to
    /// the average height of its neighbours, which is the standard barycentre
    /// heuristic for reducing edge crossings.
    private func layOutFlow() {
        var columns: [Int: [Int]] = [:]
        for i in nodes.indices {
            columns[nodes[i].flowRank, default: []].append(i)
        }
        let ranks = columns.keys.sorted()
        guard !ranks.isEmpty else { return }

        // Seed each column ordered by connectivity, so hubs start near the middle.
        for rank in ranks {
            columns[rank]?.sort { adjacency[$0].count > adjacency[$1].count }
        }

        var order: [Int: Int] = [:] // node -> slot within its column
        for rank in ranks {
            for (slot, node) in (columns[rank] ?? []).enumerated() { order[node] = slot }
        }

        // Barycentre sweeps. Four passes is where the crossing count stops
        // improving noticeably on the repositories this was tuned against.
        for _ in 0..<4 {
            for rank in ranks {
                guard var column = columns[rank], column.count > 1 else { continue }
                let bary: [Int: Double] = Dictionary(uniqueKeysWithValues: column.map { node in
                    let neighbours = adjacency[node].compactMap { order[$0] }
                    let mean = neighbours.isEmpty
                        ? Double(order[node] ?? 0)
                        : Double(neighbours.reduce(0, +)) / Double(neighbours.count)
                    return (node, mean)
                })
                column.sort { (bary[$0] ?? 0, $0) < (bary[$1] ?? 0, $1) }
                columns[rank] = column
                for (slot, node) in column.enumerated() { order[node] = slot }
            }
        }

        // Place the columns, wrapping any that are too tall.
        //
        // A service layer with forty functions in it does not fit down one side
        // of a window: at even spacing the nodes overlap and every label collides.
        // Splitting an over-full rank into side-by-side sub-columns keeps the
        // left-to-right reading — everything in the rank is still in its band —
        // while giving each node room to be labelled.
        let minimumSpacing = 26.0
        let perColumn = max(4, Int(height / minimumSpacing))

        // A rank that wraps needs proportionally more width than one that does not.
        let subColumnCounts = ranks.map { rank in
            max(1, Int(ceil(Double((columns[rank] ?? []).count) / Double(perColumn))))
        }
        let totalSubColumns = max(1, subColumnCounts.reduce(0, +))
        let subColumnWidth = width / Double(totalSubColumns)

        var placedSubColumns = 0
        for (index, rank) in ranks.enumerated() {
            let column = columns[rank] ?? []
            let subCount = subColumnCounts[index]
            let rows = Int(ceil(Double(column.count) / Double(subCount)))
            let spacing = height / Double(rows + 1)

            for (slot, node) in column.enumerated() {
                let sub = slot / max(1, rows)
                let row = slot % max(1, rows)
                let x = minX + subColumnWidth * (Double(placedSubColumns + sub) + 0.5)
                position[node] = SIMD2(x, minY + spacing * Double(row + 1))
            }
            placedSubColumns += subCount
        }
    }

    /// Hottest first, reading order. Useful when the question is "what changed",
    /// not "what depends on what".
    private func layOutGrid() {
        let order = nodes.indices.sorted { nodes[$0].heat > nodes[$1].heat }
        let columns = max(1, Int(width / 90))
        let cell = min(90.0, width / Double(columns))
        let originX = minX
        let originY = minY
        for (slot, i) in order.enumerated() {
            let row = slot / columns
            let col = slot % columns
            position[i] = SIMD2(
                originX + cell * (Double(col) + 0.5),
                originY + cell * (Double(row) + 0.5)
            )
        }
    }

    func setMode(_ newMode: Mode) {
        guard newMode != mode else { return }
        mode = newMode
        seedPositions()
        if mode == .force || mode == .orbit {
            alpha = 0.8
            start()
        } else {
            stop()
            frame += 1
        }
    }

    // MARK: - Running

    func start() {
        guard mode == .force || mode == .orbit, timer == nil, !nodes.isEmpty else { return }
        isSettling = true
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.step() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        isSettling = false
    }

    /// Nudge the simulation back to life — after a drag, or a filter change.
    func reheat(_ target: Double = 0.4) {
        guard mode == .force || mode == .orbit else { return }
        alpha = max(alpha, target)
        start()
    }

    private func step() {
        guard !nodes.isEmpty else { return }

        alpha += (alphaTarget - alpha) * alphaDecay
        if alpha < alphaMin {
            stop()
            frame += 1
            return
        }

        applyRepulsion()
        applyLinks()
        applyCentering()
        integrate()

        frame += 1
    }

    // MARK: - Forces

    /// Uniform-grid many-body repulsion.
    ///
    /// Only nodes within one cell of each other push on each other. Beyond that
    /// the force is small enough that dropping it changes the picture less than
    /// one frame of jitter does — and it turns an O(n²) frame into a linear one.
    private func applyRepulsion() {
        let cell = max(linkDistance * 2.4, 40)
        var buckets: [Int64: [Int]] = [:]
        buckets.reserveCapacity(nodes.count)

        @inline(__always)
        func key(_ x: Int, _ y: Int) -> Int64 { Int64(x) &* 73_856_093 ^ Int64(y) &* 19_349_663 }

        var cellOf = [SIMD2<Int>](repeating: .zero, count: nodes.count)
        for i in 0..<nodes.count {
            let cx = Int(floor(position[i].x / cell))
            let cy = Int(floor(position[i].y / cell))
            cellOf[i] = SIMD2(cx, cy)
            buckets[key(cx, cy), default: []].append(i)
        }

        let strength = repulsion * alpha
        let threeD = isThreeDimensional

        for i in 0..<nodes.count {
            let c = cellOf[i]
            var force = SIMD2<Double>.zero
            var depthForce = 0.0

            for dx in -1...1 {
                for dy in -1...1 {
                    guard let bucket = buckets[key(c.x + dx, c.y + dy)] else { continue }
                    for j in bucket where j != i {
                        var delta = position[i] - position[j]
                        var distanceSquared = delta.x * delta.x + delta.y * delta.y

                        // Two nodes exactly on top of each other have no direction
                        // to separate along; give them a deterministic one.
                        if distanceSquared < 0.01 {
                            delta = SIMD2(Double((i % 7) - 3) * 0.1 + 0.05, Double((j % 5) - 2) * 0.1 + 0.05)
                            distanceSquared = delta.x * delta.x + delta.y * delta.y
                        }

                        let minimum = radius[i] + radius[j] + 14
                        let dz = threeD ? depth[i] - depth[j] : 0
                        let distance = (distanceSquared + dz * dz).squareRoot()

                        // Inverse-square, with a hard shove once discs overlap so
                        // labels stay readable in dense clusters.
                        var magnitude = strength / max(0.01, distanceSquared + dz * dz)
                        if distance < minimum { magnitude += (minimum - distance) * 0.9 }

                        force += delta / distance * magnitude
                        if threeD { depthForce += dz / distance * magnitude }
                    }
                }
            }
            velocity[i] += force
            if threeD { depthVelocity[i] += depthForce }
        }
    }

    private func applyLinks() {
        let threeD = isThreeDimensional
        for link in links {
            let delta = position[link.b] - position[link.a]
            let dz = threeD ? depth[link.b] - depth[link.a] : 0
            let distance = max(0.01, (delta.x * delta.x + delta.y * delta.y + dz * dz).squareRoot())
            let target = linkDistance + radius[link.a] + radius[link.b]

            // Inferred edges are weaker: they are the model's opinion, and they
            // should not drag the layout as hard as a real import does.
            let stiffness = (link.inferred ? 0.06 : 0.12) * alpha * link.weight
            let displacement = (distance - target) * stiffness
            let push = delta / distance * displacement
            let depthPush = threeD ? dz / distance * displacement : 0

            if !pinned[link.a] {
                velocity[link.a] += push
                if threeD { depthVelocity[link.a] += depthPush }
            }
            if !pinned[link.b] {
                velocity[link.b] -= push
                if threeD { depthVelocity[link.b] -= depthPush }
            }
        }
    }

    /// Centering, shaped like the viewport.
    ///
    /// A uniform pull settles every graph into a circle, which wastes most of a
    /// wide panel and forces the fit to zoom out to whatever the vertical
    /// dimension allows. Easing the horizontal pull in proportion to the aspect
    /// ratio lets the graph spread into the space it actually has.
    private func applyCentering() {
        let centre = SIMD2(midX, midY)
        if isThreeDimensional {
            // A sphere wants an isotropic pull; the aspect-ratio trick is for
            // filling a wide panel, which does not apply once you can orbit.
            for i in 0..<nodes.count {
                velocity[i] += (centre - position[i]) * centerPull * alpha
                depthVelocity[i] += (0 - depth[i]) * centerPull * alpha
            }
            return
        }
        let aspect = max(0.2, min(5, width / max(1, height)))
        let pull = SIMD2(centerPull / aspect, centerPull)
        for i in 0..<nodes.count {
            velocity[i] += (centre - position[i]) * pull * alpha
        }
    }

    private func integrate() {
        let threeD = isThreeDimensional
        for i in 0..<nodes.count where !pinned[i] {
            velocity[i] *= damping
            if threeD { depthVelocity[i] *= damping }

            // Cap the step so a node that ends up inside another cannot be
            // catapulted off screen.
            let dz = threeD ? depthVelocity[i] : 0
            let speed = (velocity[i].x * velocity[i].x + velocity[i].y * velocity[i].y + dz * dz).squareRoot()
            if speed > 40 {
                velocity[i] *= 40 / speed
                if threeD { depthVelocity[i] *= 40 / speed }
            }
            position[i] += velocity[i]
            if threeD { depth[i] += depthVelocity[i] }
        }
    }

    // MARK: - Interaction

    func pin(_ index: Int, at point: CGPoint) {
        guard nodes.indices.contains(index) else { return }
        pinned[index] = true
        position[index] = SIMD2(Double(point.x), Double(point.y))
        velocity[index] = .zero
        if index < depthVelocity.count { depthVelocity[index] = 0 }
        reheat(0.32)
    }

    func unpin(_ index: Int) {
        guard nodes.indices.contains(index) else { return }
        pinned[index] = false
    }

    /// Nearest node within its own radius of the point, in graph coordinates.
    func hitTest(_ point: CGPoint, tolerance: Double = 6) -> Int? {
        var best: Int?
        var bestDistance = Double.infinity
        let px = Double(point.x)
        let py = Double(point.y)
        for i in 0..<nodes.count {
            let dx = position[i].x - px
            let dy = position[i].y - py
            let distance = (dx * dx + dy * dy).squareRoot()
            if distance <= radius[i] + tolerance, distance < bestDistance {
                best = i
                bestDistance = distance
            }
        }
        return best
    }

    /// The bounding box of everything laid out, for "fit to window".
    /// The radius of the point cloud, used to place the camera in orbit mode.
    func contentRadius() -> Double {
        guard !position.isEmpty else { return 1 }
        let cx = position.reduce(0.0) { $0 + $1.x } / Double(position.count)
        let cy = position.reduce(0.0) { $0 + $1.y } / Double(position.count)
        let cz = depth.reduce(0.0, +) / Double(max(1, depth.count))
        var maximum = 1.0
        for i in position.indices {
            let dx = position[i].x - cx
            let dy = position[i].y - cy
            let dz = (i < depth.count ? depth[i] : 0) - cz
            maximum = max(maximum, (dx * dx + dy * dy + dz * dz).squareRoot() + radius[i])
        }
        return maximum
    }

    /// The centre of the point cloud in three dimensions.
    func contentCentre() -> SIMD3<Double> {
        guard !position.isEmpty else { return SIMD3(midX, midY, 0) }
        let n = Double(position.count)
        return SIMD3(
            position.reduce(0.0) { $0 + $1.x } / n,
            position.reduce(0.0) { $0 + $1.y } / n,
            depth.reduce(0.0, +) / Double(max(1, depth.count))
        )
    }

    func contentBounds() -> CGRect {
        guard !position.isEmpty else { return bounds }
        var minX = Double.infinity, minY = Double.infinity
        var maxX = -Double.infinity, maxY = -Double.infinity
        for (i, p) in position.enumerated() {
            minX = min(minX, p.x - radius[i])
            minY = min(minY, p.y - radius[i])
            maxX = max(maxX, p.x + radius[i])
            maxY = max(maxY, p.y + radius[i])
        }
        return CGRect(x: minX, y: minY, width: max(1, maxX - minX), height: max(1, maxY - minY))
    }

    func neighbours(of index: Int) -> Set<Int> {
        adjacency.indices.contains(index) ? adjacency[index] : []
    }
}
