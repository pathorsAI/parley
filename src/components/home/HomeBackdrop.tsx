import type { CSSProperties } from "react";

/**
 * 總覽's backdrop, from the UX file (Figma "Integrations — Main Content",
 * 3105:4659): a pale blue wash fading to the page grey, under a row of thirteen
 * vertical light bars that rise into place one after another when the page
 * opens (60 ms apart, half a second each).
 *
 * Each bar fades out to transparent at both ends rather than to the design's
 * #eef9ff, which is the same colour against the light wash and lets the bars
 * sit on the dark theme too. Purely decorative: no pointer events, hidden from
 * assistive tech, and still under reduced motion.
 */

/** One bar: its column (left/right insets, %), height and vertical offset from
 *  the layer's middle (px), core colour and opacity, as drawn. */
type Bar = { left: number; right: number; h: number; dy: number; core: string; o: number; at?: string };

const BARS: Bar[] = [
  { left: 0, right: 92.31, h: 689.363, dy: 3.18, core: "#1469d4", o: 0.3 },
  { left: 7.71, right: 84.6, h: 445.749, dy: -410.63, core: "#1979da", o: 0.4 },
  { left: 15.42, right: 76.89, h: 353.586, dy: 14.1, core: "#1d86e0", o: 0.5, at: "49.519%" },
  { left: 23.16, right: 69.15, h: 297.546, dy: -200.59, core: "#2191e4", o: 0.6 },
  { left: 30.75, right: 61.59, h: 258, dy: -58.36, core: "rgba(33,145,228,0.9)", o: 0.7 },
  { left: 38.47, right: 53.82, h: 223.018, dy: -228.03, core: "rgba(42,172,239,0.8)", o: 0.8 },
  { left: 46.16, right: 46.17, h: 381, dy: -203.86, core: "rgba(45,182,243,0.7)", o: 1 },
  { left: 53.82, right: 38.47, h: 261.839, dy: -288.18, core: "rgba(42,172,239,0.8)", o: 0.8 },
  { left: 61.57, right: 30.72, h: 294.053, dy: -76.34, core: "rgba(37,157,233,0.9)", o: 0.7 },
  { left: 69.24, right: 23.07, h: 264.968, dy: -394.47, core: "#2191e4", o: 0.6 },
  { left: 76.94, right: 15.35, h: 328.745, dy: -228.99, core: "#1d86e0", o: 0.5, at: "49.519%" },
  { left: 84.65, right: 7.68, h: 511, dy: -112.86, core: "#1979da", o: 0.4 },
  { left: 92.36, right: -0.05, h: 571.586, dy: -322.1, core: "#1469d4", o: 0.3 },
];

/** The design frame is 652 px tall; the bars' layer spans -26.44% to 35.17%
 *  from its bottom, i.e. 595 px starting 172 px above the top. */
const LAYER_TOP = -172;
const LAYER_HEIGHT = 595;

export function HomeBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-linear-to-b from-[#f0f9ff] to-[#fafafa] dark:from-primary/10 dark:to-background" />
      <div className="absolute inset-x-0 opacity-30 dark:opacity-20" style={{ top: LAYER_TOP, height: LAYER_HEIGHT }}>
        {BARS.map((b, i) => (
          <div
            key={b.left}
            className="absolute -translate-y-1/2"
            style={{ left: `${b.left}%`, right: `${b.right}%`, height: b.h, top: `calc(50% + ${b.dy}px)` }}
          >
            {/* Rises in (its own layer, so the rise doesn't fight the centring
                transform above or the bar's opacity below). */}
            <div className="home-bar size-full" style={{ "--home-bar-delay": `${i * 60}ms` } as CSSProperties}>
              <div
                className="size-full"
                style={{
                  opacity: b.o,
                  backgroundImage: `linear-gradient(180deg, transparent 0%, ${b.core} ${b.at ?? "50%"}, transparent 100%)`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
