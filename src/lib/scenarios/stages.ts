/**
 * The stage vocabulary a scenario is built from.
 *
 * A scenario is an ordered list of stages; each stage owns a slot board. The
 * five sales stages are builtin because they are the ones the app ships copy
 * for — every other stage id is a user-defined string from the stage-bundle
 * file, which is why {@link SalesStage} is `string` rather than a union.
 */

export type BuiltinSalesStage =
  | "prospecting"
  | "discovery"
  | "demo"
  | "negotiation"
  | "closing";

/** A stage id: one of the builtins, or a custom id from the bundle file. */
export type SalesStage = string;

export const SALES_STAGES: BuiltinSalesStage[] = [
  "prospecting",
  "discovery",
  "demo",
  "negotiation",
  "closing",
];
