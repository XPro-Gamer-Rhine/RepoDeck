// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "contract-check",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "contract-check",
            // The app's DTOs are compiled in directly rather than copied, so this
            // can never drift from what the app actually decodes.
            path: "Sources/contract-check"
        )
    ]
)
