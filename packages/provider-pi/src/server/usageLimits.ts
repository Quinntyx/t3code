import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// Pi reports subscription limits only as text, e.g. pi-ai's ChatGPT message
// "You have hit your ChatGPT usage limit (team plan). Try again in ~275 min."
const USAGE_LIMIT = /\busage limit\b|subscription_sharing_usage_limit_exceeded/i;
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
