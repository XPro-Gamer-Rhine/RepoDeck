// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RepoDeck",
    platforms: [
        // NavigationSplitView, Canvas and the Observation-friendly SwiftUI the
        // graph view leans on.
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "RepoDeck",
            path: "Sources/RepoDeck"
        )
    ]
)
