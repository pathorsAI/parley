import ParleyKit
import SwiftUI

struct PressedKey: Equatable {
    let label: String
    let bounds: Anchor<CGRect>
}

struct PressedKeys: PreferenceKey {
    static let defaultValue: [PressedKey] = []
    static func reduce(value: inout [PressedKey], nextValue: () -> [PressedKey]) {
        value += nextValue()
    }
}

struct KeyCalloutLayer: View {
    let dark: Bool
    let keys: [PressedKey]

    var body: some View {
        GeometryReader { proxy in
            ForEach(Array(keys.enumerated()), id: \.offset) { _, pressed in
                let key = proxy[pressed.bounds]
                KeyCallout(
                    dark: dark, label: pressed.label, key: key,
                    layout: KeyCalloutGeometry.layout(key: key, in: proxy.size))
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct KeyCallout: View {
    let dark: Bool
    let label: String
    let key: CGRect
    let layout: KeyCalloutLayout

    var body: some View {
        let frame = layout.bubble.union(key)
        ZStack(alignment: .topLeading) {
            KeyCalloutShape(
                bubble: layout.bubble.offsetBy(dx: -frame.minX, dy: -frame.minY),
                key: key.offsetBy(dx: -frame.minX, dy: -frame.minY)
            )
            .fill(KBTheme.key(dark))
            .shadow(color: .black.opacity(dark ? 0.5 : 0.22), radius: 3, y: 1)
            Text(verbatim: label)
                .font(.system(size: layout.glyphSize))
                .foregroundStyle(KBTheme.ink(dark))
                .position(
                    x: layout.glyphCenter.x - frame.minX, y: layout.glyphCenter.y - frame.minY)
        }
        .frame(width: frame.width, height: frame.height)
        .position(x: frame.midX, y: frame.midY)
    }
}

/// `bubble` and `key` are relative to the shape's own frame.
private struct KeyCalloutShape: Shape {
    let bubble: CGRect
    let key: CGRect

    private static let bubbleCorner: CGFloat = 8
    private static let capCorner: CGFloat = 5
    private static let filletLimit: CGFloat = 6
    private static let edgeCornerLimit: CGFloat = 4

    func path(in rect: CGRect) -> Path {
        let b = bubble.offsetBy(dx: rect.minX, dy: rect.minY)
        let s = key.offsetBy(dx: rect.minX, dy: rect.minY)
        let top = min(Self.bubbleCorner, b.height / 2)
        let cap = Self.capCorner
        let leftFlare = s.minX - b.minX
        let rightFlare = b.maxX - s.maxX
        let filletL = min(Self.filletLimit, leftFlare / 2)
        let filletR = min(Self.filletLimit, rightFlare / 2)
        let cornerL = min(Self.edgeCornerLimit, leftFlare / 2)
        let cornerR = min(Self.edgeCornerLimit, rightFlare / 2)

        var p = Path()
        p.move(to: CGPoint(x: s.minX, y: s.maxY - cap))
        p.addLine(to: CGPoint(x: s.minX, y: b.maxY + filletL))
        p.addQuadCurve(
            to: CGPoint(x: s.minX - filletL, y: b.maxY), control: CGPoint(x: s.minX, y: b.maxY))
        p.addLine(to: CGPoint(x: b.minX + cornerL, y: b.maxY))
        p.addQuadCurve(
            to: CGPoint(x: b.minX, y: b.maxY - cornerL), control: CGPoint(x: b.minX, y: b.maxY))
        p.addLine(to: CGPoint(x: b.minX, y: b.minY + top))
        p.addQuadCurve(
            to: CGPoint(x: b.minX + top, y: b.minY), control: CGPoint(x: b.minX, y: b.minY))
        p.addLine(to: CGPoint(x: b.maxX - top, y: b.minY))
        p.addQuadCurve(
            to: CGPoint(x: b.maxX, y: b.minY + top), control: CGPoint(x: b.maxX, y: b.minY))
        p.addLine(to: CGPoint(x: b.maxX, y: b.maxY - cornerR))
        p.addQuadCurve(
            to: CGPoint(x: b.maxX - cornerR, y: b.maxY), control: CGPoint(x: b.maxX, y: b.maxY))
        p.addLine(to: CGPoint(x: s.maxX + filletR, y: b.maxY))
        p.addQuadCurve(
            to: CGPoint(x: s.maxX, y: b.maxY + filletR), control: CGPoint(x: s.maxX, y: b.maxY))
        p.addLine(to: CGPoint(x: s.maxX, y: s.maxY - cap))
        p.addQuadCurve(
            to: CGPoint(x: s.maxX - cap, y: s.maxY), control: CGPoint(x: s.maxX, y: s.maxY))
        p.addLine(to: CGPoint(x: s.minX + cap, y: s.maxY))
        p.addQuadCurve(
            to: CGPoint(x: s.minX, y: s.maxY - cap), control: CGPoint(x: s.minX, y: s.maxY))
        p.closeSubpath()
        return p
    }
}
