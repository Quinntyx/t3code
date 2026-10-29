import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

import { clampPercent, makeUsageLimits } from "./usageLimits.ts";

/** OpenCode Zen Go exposes the same quota whether the account is driven by OpenCode or Pi. */
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});
type UsageResponse = Schema.Schema.Type<typeof UsageResponse>;

export type OpenCodeGoUsageResult =
  | { readonly _tag: "limits"; readonly limits: ServerProviderUsageLimits }
  /** The key is valid but the account has no Go subscription. */
  | { readonly _tag: "noSubscription" }
  | { readonly _tag: "failed" };

function openCodeGoUsageWindows(body: UsageResponse): ReadonlyArray<ServerProviderUsageWindow> {
  return [
    {
      id: "go_rolling",
      kind: "session",
      label: "Go · Session",
      windowDurationMins: 5 * 60,
      usedPercent: clampPercent(body.usage.rolling.percent),
      resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
    },
    {
      id: "go_weekly",
      kind: "weekly",
      label: "Go · Weekly",
      windowDurationMins: 7 * 24 * 60,
      usedPercent: clampPercent(body.usage.weekly.percent),
      resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
    },
    {
      id: "go_monthly",
      kind: "monthly",
      label: "Go · Monthly",
      usedPercent: clampPercent(body.usage.monthly.percent),
      resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
    },
  ];
}

/**
 * `fallbackApiKey` is the stored `opencode-go` credential: OpenCode prefers a
 * Console connection over it, so a rejected Console key gets one retry.
 */
const readUsage = Effect.fn("readOpenCodeGoUsage")(function* (input: {
  readonly apiKey: string;
  readonly fallbackApiKey?: string | undefined;
  readonly checkedAt: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const readUsage = (key: string) =>
    client.execute(
      HttpClientRequest.get(OPENCODE_GO_USAGE_URL).pipe(HttpClientRequest.bearerToken(key)),
    );

  let apiKey = input.apiKey;
  let response = yield* readUsage(apiKey);
  if (
    (response.status === 401 || response.status === 403) &&
    input.fallbackApiKey &&
    input.fallbackApiKey !== apiKey
  ) {
    apiKey = input.fallbackApiKey;
    response = yield* readUsage(apiKey);
  }
  if (response.status === 403) return { _tag: "noSubscription" } as const;

  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
  );
  // Unkeyed hashes match across environments; random Go keys resist offline guessing.
  const credentialFingerprint = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`opencode-go\0${apiKey}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return {
    _tag: "limits",
    limits: {
      ...makeUsageLimits({ checkedAt: input.checkedAt, windows: openCodeGoUsageWindows(body) }),
      credentialFingerprint,
    },
  } as const;
});

export const readOpenCodeGoUsage = (input: {
  readonly apiKey: string;
  readonly fallbackApiKey?: string | undefined;
  readonly checkedAt: string;
}) => readUsage(input).pipe(Effect.orElseSucceed(() => ({ _tag: "failed" }) as const));
