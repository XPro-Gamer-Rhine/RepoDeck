// Generates the 1024×1024 app icon: a dark squircle carrying a small
// dependency graph, with the hot nodes lit the way the app lights them.
//
//   swift make-icon.swift <output.png>
//
// The icon is the product's one-sentence claim — a repository as a graph, with
// heat on it — so it is drawn from the same idea as the canvas rather than
// borrowed from a symbol set.

import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"

let size = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: 0, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("could not create a bitmap context") }

let side = CGFloat(size)
let inset: CGFloat = 78          // matches macOS icon padding
let box = CGRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)

// ── background: the canvas the graph is drawn on ─────────────────────────────
let squircle = CGPath(roundedRect: box, cornerWidth: box.width * 0.235,
                      cornerHeight: box.height * 0.235, transform: nil)
ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()

let bg = CGGradient(colorsSpace: colorSpace, colors: [
    CGColor(red: 0.09, green: 0.10, blue: 0.14, alpha: 1),
    CGColor(red: 0.05, green: 0.05, blue: 0.08, alpha: 1),
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: box.minX, y: box.maxY),
                       end: CGPoint(x: box.maxX, y: box.minY), options: [])

// ── the graph ────────────────────────────────────────────────────────────────
// Positions are hand-placed rather than simulated: at icon scale a real force
// layout reads as noise, and the shape has to survive being 16px wide.
struct Node {
    let x: CGFloat, y: CGFloat, r: CGFloat
    let hue: CGFloat, sat: CGFloat, heat: CGFloat
}

let c = CGPoint(x: box.midX, y: box.midY)
let u = box.width / 100   // one unit = 1% of the icon

let nodes: [Node] = [
    Node(x: c.x,             y: c.y + 22 * u, r: 7.0 * u, hue: 352 / 360, sat: 0.78, heat: 1.00), // route, hottest
    Node(x: c.x - 26 * u,    y: c.y + 4 * u,  r: 5.6 * u, hue: 214 / 360, sat: 0.72, heat: 0.55), // controller
    Node(x: c.x + 26 * u,    y: c.y + 4 * u,  r: 5.6 * u, hue: 188 / 360, sat: 0.70, heat: 0.72), // service
    Node(x: c.x - 14 * u,    y: c.y - 24 * u, r: 4.6 * u, hue: 46 / 360,  sat: 0.80, heat: 0.35), // model
    Node(x: c.x + 15 * u,    y: c.y - 25 * u, r: 4.4 * u, hue: 128 / 360, sat: 0.62, heat: 0.48), // job
    Node(x: c.x,             y: c.y - 2 * u,  r: 8.4 * u, hue: 272 / 360, sat: 0.66, heat: 0.88), // the hub
]

let edges: [(Int, Int)] = [(0, 5), (1, 5), (2, 5), (3, 5), (4, 5), (1, 3), (2, 4), (0, 1), (0, 2)]

func colour(_ n: Node, alpha: CGFloat = 1) -> CGColor {
    // Same rule as the app: hue says what, brightness says how hot.
    NSColor(hue: n.hue, saturation: n.sat, brightness: 0.36 + 0.60 * n.heat, alpha: alpha).cgColor
}

ctx.setLineCap(.round)
for (a, b) in edges {
    let from = nodes[a], to = nodes[b]
    ctx.setStrokeColor(NSColor(hue: from.hue, saturation: 0.45, brightness: 0.70, alpha: 0.42).cgColor)
    ctx.setLineWidth(1.7 * u)
    ctx.move(to: CGPoint(x: from.x, y: from.y))
    ctx.addLine(to: CGPoint(x: to.x, y: to.y))
    ctx.strokePath()
}

for n in nodes {
    // Glow first, so it sits under every node rather than over its neighbours.
    if n.heat > 0.3 {
        let glowR = n.r * (2.1 + n.heat)
        let glow = CGGradient(colorsSpace: colorSpace, colors: [
            colour(n, alpha: 0.42 * n.heat), colour(n, alpha: 0),
        ] as CFArray, locations: [0, 1])!
        ctx.drawRadialGradient(
            glow,
            startCenter: CGPoint(x: n.x, y: n.y), startRadius: n.r * 0.5,
            endCenter: CGPoint(x: n.x, y: n.y), endRadius: glowR,
            options: []
        )
    }
}

for n in nodes {
    ctx.setFillColor(colour(n))
    ctx.fillEllipse(in: CGRect(x: n.x - n.r, y: n.y - n.r, width: n.r * 2, height: n.r * 2))
    ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.35))
    ctx.setLineWidth(0.6 * u)
    ctx.strokeEllipse(in: CGRect(x: n.x - n.r, y: n.y - n.r, width: n.r * 2, height: n.r * 2))
}

ctx.restoreGState()

// A hairline edge, so the icon reads as a distinct object on a light desktop.
ctx.addPath(squircle)
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.10))
ctx.setLineWidth(3)
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("could not render the icon") }
let url = URL(fileURLWithPath: outPath)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("could not open \(outPath) for writing")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(outPath)") }
print("wrote \(outPath)")
