// Hosted-plan usage meter for the "parley" provider. Reads the signed-in user's
// quota from Parley Cloud so Settings can show how much of the monthly STT-hours
// pool and LLM-credit allowance is left. The real cost accounting and quota
// enforcement live server-side; this is a read-only view of the period counters.

import { cloudFetch } from "./client";
import type { HostedQuota } from "./types";

export type { HostedQuota } from "./types";

/**
 * Fetch the signed-in user's hosted-plan usage for the current billing period.
 * Throws (via cloudFetch) on a non-2xx response so callers can surface a toast;
 * a 401 there also clears the dead session in the shared client.
 */
export async function fetchHostedQuota(): Promise<HostedQuota> {
  const res = await cloudFetch("/me/usage");
  return (await res.json()) as HostedQuota;
}
