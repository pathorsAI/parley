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
 * A provider hosted on a Parley account (`requiresAccount` in the STT and LLM
 * registries — today "parley") only exists in the cloud build and only when
 * signed in (the session token IS its credential); every other provider is
 * always offered.
 */
export function isProviderListed(
  p: { readonly requiresAccount?: boolean },
  ctx: ProviderListingContext,
): boolean {
  return !p.requiresAccount || (ctx.cloudEnabled && ctx.signedIn);
}
