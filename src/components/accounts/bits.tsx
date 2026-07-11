/** Tiny shared account-area primitives. */

/** Stance as a colored dot: green support, gray neutral/unknown, red oppose. */
export function StanceDot({
  stance,
}: Readonly<{ stance?: "support" | "neutral" | "oppose" }>) {
  const cls =
    stance === "support"
      ? "bg-emerald-500"
      : stance === "oppose"
        ? "bg-red-500"
        : "bg-muted-foreground/40";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${cls}`} />;
}
