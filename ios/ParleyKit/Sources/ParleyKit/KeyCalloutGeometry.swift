import CoreGraphics

/// Where a held key's callout goes, in the same coordinate space as the key.
public struct KeyCalloutLayout: Equatable, Sendable {
    /// The magnified-label box, wholly above the key and never above y = 0.
    /// Centred over the key unless that would cross the container's edge; then
    /// it lines up with the key's outer edge and flares inward only.
    public let bubble: CGRect
    public let glyphCenter: CGPoint
    public let glyphSize: CGFloat
}

public enum KeyCalloutGeometry {
    private static let flareInKeyWidths: CGFloat = 0.4
    private static let neckInKeyHeights: CGFloat = 0.25
    private static let bubbleHeightInKeyHeights: CGFloat = 1.5
    private static let glyphInFullBubbleHeights: CGFloat = 0.55
    private static let maxGlyphInBubbleHeights: CGFloat = 0.9

    /// `key` and the result are in the coordinate space of `container`, whose
    /// origin is the keyboard's top-left.
    public static func layout(key: CGRect, in container: CGSize) -> KeyCalloutLayout {
        let fullHeight = bubbleHeightInKeyHeights * key.height
        let neck = neckInKeyHeights * key.height
        let rise = min(fullHeight + neck, key.minY)
        let height = max(rise - neck, 0)
        let flare = flareInKeyWidths * key.width
        let width = key.width + 2 * flare
        let centred = key.minX - flare
        let x =
            centred < 0
            ? key.minX
            : centred + width > container.width ? key.maxX - width : centred
        let bubble = CGRect(x: x, y: key.minY - rise, width: width, height: height)
        return KeyCalloutLayout(
            bubble: bubble,
            glyphCenter: CGPoint(x: bubble.midX, y: bubble.midY),
            glyphSize: min(
                glyphInFullBubbleHeights * fullHeight, maxGlyphInBubbleHeights * height))
    }
}
