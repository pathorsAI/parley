/**
 * Dependency-free SVG donut chart. Renders one arc per slice plus a legend.
 * Kept tiny on purpose — no charting library, no canvas.
 */

export interface PieSlice {
  label: string;
  value: number;
  /** Any CSS color. */
  color: string;
}

interface PieChartProps {
  slices: PieSlice[];
  /** Diameter in px. */
  size?: number;
  /** Donut hole ratio (0 = full pie, 0.6 = thin ring). */
  thickness?: number;
  /** Rendered in the donut hole (e.g. a total). */
  centerLabel?: string;
  centerSub?: string;
  /** Formats the value shown in the legend. */
  formatValue?: (v: number) => string;
}

function polar(cx: number, cy: number, r: number, frac: number) {
  // frac in [0,1]; start at 12 o'clock, go clockwise.
  const a = frac * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

export function PieChart({
  slices,
  size = 160,
  thickness = 0.62,
  centerLabel,
  centerSub,
  formatValue = (v) => String(v),
}: PieChartProps) {
  const data = slices.filter((s) => s.value > 0);
  const total = data.reduce((sum, s) => sum + s.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;
  const innerR = r * thickness;

  let acc = 0;
  const arcs = data.map((s) => {
    const start = acc / total;
    acc += s.value;
    const end = acc / total;
    const large = end - start > 0.5 ? 1 : 0;
    const p0 = polar(cx, cy, r, start);
    const p1 = polar(cx, cy, r, end);
    const i0 = polar(cx, cy, innerR, end);
    const i1 = polar(cx, cy, innerR, start);
    // Full-circle single slice can't be drawn with one arc — nudge it.
    const d =
      data.length === 1
        ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} ` +
          `L ${cx - 0.01} ${cy - innerR} A ${innerR} ${innerR} 0 1 0 ${cx} ${cy - innerR} Z`
        : `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 1 ${p1.x} ${p1.y} ` +
          `L ${i0.x} ${i0.y} A ${innerR} ${innerR} 0 ${large} 0 ${i1.x} ${i1.y} Z`;
    return { d, color: s.color };
  });

  return (
    <div className="flex items-center gap-4">
      {total > 0 ? (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {arcs.map((a, i) => (
              <path key={i} d={a.d} fill={a.color} />
            ))}
          </svg>
          {(centerLabel || centerSub) && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              {centerLabel && <span className="text-sm font-semibold tabular-nums">{centerLabel}</span>}
              {centerSub && <span className="text-[10px] text-muted-foreground">{centerSub}</span>}
            </div>
          )}
        </div>
      ) : (
        <div
          className="flex shrink-0 items-center justify-center rounded-full border border-dashed text-[10px] text-muted-foreground"
          style={{ width: size, height: size }}
        >
          —
        </div>
      )}

      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {data.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{formatValue(s.value)}</span>
          </li>
        ))}
        {data.length === 0 && <li className="text-xs text-muted-foreground">—</li>}
      </ul>
    </div>
  );
}
