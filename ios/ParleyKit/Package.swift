// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ParleyKit",
    platforms: [
        .iOS(.v17),
        // macOS included so the core (segment building, relay protocol) can be
        // unit-tested on CI and dev machines without an iOS simulator runtime.
        .macOS(.v14),
    ],
    products: [
        .library(name: "ParleyKit", targets: ["ParleyKit"])
    ],
    targets: [
        .target(name: "ParleyKit"),
        .testTarget(name: "ParleyKitTests", dependencies: ["ParleyKit"]),
    ]
)
