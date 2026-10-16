/**
 * Which providers a picker offers. Shared by the STT and LLM pickers in
 * Settings and in Onboarding, which used to repeat the same inline filter four
 * times. Pure, so the rule is unit-tested once.
 */
export interface ProviderListingContext {
  /** The cloud edition is compiled in (`CLOUD_ENABLED`). */
  cloudEnabled: boolean;
  /** A cloud session exists (`cloudAuth` is set). */
  signedIn: boolean;
}

/**
 * The hosted "parley" provider only exists in the cloud build and only when
 * signed in (the session token IS its credential); every other provider is
 * always offered.
 */
export function isProviderListed(p: { id: string }, ctx: ProviderListingContext): boolean {
  return p.id !== "parley" || (ctx.cloudEnabled && ctx.signedIn);
}
