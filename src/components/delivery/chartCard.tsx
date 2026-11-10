import type { ReactNode } from "react";
import { clock } from "../../lib/analysis/speechStats";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";

/** A card with a small title, the chart, and an optional one-line reading of it. */
export function Chart({ title, note, children }: Readonly<{ title: string; note?: ReactNode; children: ReactNode }>) {
  return (
    <Card size="sm" className="min-w-0 gap-2 shadow-none">
      <CardHeader>
        <CardTitle className="text-xs font-semibold text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
      {note && (
        <CardFooter className="flex-wrap gap-y-1 bg-transparent py-2 text-[11px] text-muted-foreground">{note}</CardFooter>
      )}
    </Card>
  );
}

/** A meeting timestamp, as a small neutral chip. */
export function Stamp({ ms }: Readonly<{ ms: number }>) {
  return (
    <Badge variant="outline" className="ml-1 h-4 rounded-sm px-1 font-mono text-[10px] font-normal text-muted-foreground">
      {clock(ms)}
    </Badge>
  );
}
