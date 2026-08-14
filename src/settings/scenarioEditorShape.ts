/**
 * What the scenario editor shows once a scenario row is expanded.
 *
 * Lives outside the component because the rule it encodes — one expand puts the
 * whole editor on screen — is the thing that kept regressing into a second
 * layer of accordions. Only a multi-stage scenario (in practice: sales) has
 * anything to choose between; a single-stage scenario must never make the user
 * learn that "stage" is a concept.
 */
export type ScenarioEditorShape = "kind" | "single" | "multi";

export function scenarioEditorShape(order: readonly string[]): ScenarioEditorShape {
  if (order.length === 0) return "kind";
  return order.length === 1 ? "single" : "multi";
}

/** The stage a freshly expanded scenario edits. Null only for a boardless kind. */
export function initialStageId(order: readonly string[]): string | null {
  return order[0] ?? null;
}

/** Where the selection lands after the current stage is deleted: the first
 *  survivor, so the form stays populated instead of blanking the panel. */
export function stageAfterRemoval(
  order: readonly string[],
  removed: string
): string | null {
  return initialStageId(order.filter((id) => id !== removed));
}
