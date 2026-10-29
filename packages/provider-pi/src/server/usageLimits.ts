import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// Pi reports limits as text: pi-ai's "You have hit your ChatGPT usage limit
// (team plan).", or a gateway's bare upstream code "usage_limit_reached".
// Transient throttling (429, "rate limit") is absent on purpose: Pi retries
// those, so they stay provider errors.
const USAGE_LIMIT =
  /\busage limit\b|usage_limit|usage_not_included|insufficient_quota|quota exceeded/i;
const TRY_AGAIN_IN_MINUTES = /\btry again in ~?(\d+)\s*min/i;

export function piFailureClassification(
  message: string,
  now: DateTime.Utc,
): { readonly class: OrchestrationV2ProviderFailureClass; readonly resetAt: string | null } {
  if (!USAGE_LIMIT.test(message)) return { class: "provider_error", resetAt: null };
  const minutes = Number(TRY_AGAIN_IN_MINUTES.exec(message)?.[1]);
  return {
    class: "usage_limit",
    resetAt:
      Number.isSafeInteger(minutes) && minutes > 0
        ? DateTime.formatIso(DateTime.add(now, { minutes }))
        : null,
  };
}
