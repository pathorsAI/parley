import type { CSSProperties } from "react";

/** When each stroke starts and how long it takes to draw, in ms. */
const UNDERLINE = { delay: 450, ms: 600 };
const ARROW = { delay: 1000, ms: 700 };
const HEAD = { delay: 1650, ms: 250 };

const timing = ({ delay, ms }: { delay: number; ms: number }) =>
  ({ "--ob-draw-delay": `${delay}ms`, "--ob-draw-ms": `${ms}ms` }) as CSSProperties;

/**
 * The setup-done screen's hand-drawn marks, from the Figma frame: a scribbled
 * underline under the end of the line about the sample, and a curly arrow
 * from it down to "Try the sample". They draw themselves in once the screen
 * shows — underline, arrow, arrowhead — and just appear under reduced motion
 * (`.ob-draw`). Placed against the paragraph they mark, which must be
 * `relative`: their offsets from its right and bottom edges are the frame's.
 */
export function DoneScribbles() {
  return (
    <>
      <svg
        aria-hidden
        className="pointer-events-none absolute top-[calc(100%+0.5px)] right-[10px] text-primary"
        width="135"
        height="7"
        viewBox="0 0 135 7"
        fill="none"
      >
        <path
          className="ob-draw"
          style={timing(UNDERLINE)}
          pathLength={1}
          d="M0.5 0.5 L30 0.5 L0.5 6 C15.67 2.5 64.1 -0.3 134.5 2.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg
        aria-hidden
        className="pointer-events-none absolute top-[calc(100%+3.5px)] right-[38px] text-primary"
        width="46"
        height="53"
        viewBox="0 0 46 53"
        fill="none"
      >
        <path
          className="ob-draw"
          style={timing(ARROW)}
          pathLength={1}
          d="M45.1053 2.79108C45.3527 3.38198 45.8571 5.99669 45.1422 14.6463C44.6467 20.642 40.1849 25.574 37.8872 27.9471C36.0813 29.8122 34.433 30.0106 32.0533 29.9519C31.1936 29.9306 29.473 28.8217 29.1679 27.7333C29.0108 27.1728 29.0235 26.554 29.1028 26.0432C29.1821 25.5324 30.041 24.8943 30.6057 24.6671C32.0186 24.0986 33.3829 24.5965 34.202 24.9101C36.3476 25.7318 37.2276 28.8162 35.8757 32.7159C34.0083 38.1022 30.7533 39.7886 26.7208 42.12C24.537 43.3826 20.7951 44.1904 16.4297 45.5C7.35849 47.7429 3.48971 47.8809 2.32167 47.9405C1.78396 47.9657 1.35795 47.9807 1.21032 48.3674"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="ob-draw"
          style={timing(HEAD)}
          pathLength={1}
          d="M3.68704 44.0928C3.63566 44.2014 3.26855 44.7322 2.2476 46.2443C1.87908 46.7901 0.741917 48.6045 0.499651 48.8477C0.957288 49.048 1.52832 48.4571 3.49006 49.0908C4.23629 49.3319 5.99017 49.8635 6.91468 50.3245"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}
