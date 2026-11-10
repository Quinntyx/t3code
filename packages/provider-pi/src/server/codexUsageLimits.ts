import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PiSettings } from "../settings.ts";
import { readPiCredential } from "./piCredentials.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const PROBE_TIMEOUT_MS = 5_000;
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

const CodexWindow = Schema.Struct({
  used_percent: Schema.Finite,
  reset_at: Schema.optional(Schema.NullOr(Schema.Finite)),
  limit_window_seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const CodexUsage = Schema.Struct({
  email: Schema.optional(Schema.String),
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    }),
  ),
});

export interface PiCodexUsageLimits {
  readonly limits: ServerProviderUsageLimits;
  readonly email: string | undefined;
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function windowKind(mins: number): ServerProviderUsageWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function toWindow(
  id: string,
  window: typeof CodexWindow.Type | null | undefined,
  fallbackMins: number,
): ServerProviderUsageWindow | undefined {
  if (!window || !Number.isFinite(window.used_percent)) return undefined;
  const windowDurationMins =
    typeof window.limit_window_seconds === "number"
      ? window.limit_window_seconds / 60
      : fallbackMins;
  const kind = windowKind(windowDurationMins);
  const resetsAt = isoFromEpochSeconds(window.reset_at);
  return {
    id,
    kind,
    label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly",
    usedPercent: clampPercent(window.used_percent),
    windowDurationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export const readPiCodexUsageLimits = Effect.fn("readPiCodexUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  PiCodexUsageLimits,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled) return { limits: unsupported, email: undefined };

  const token = yield* readPiCredential(
    input.settings,
    input.environment,
    "print-bearer-token",
    "openai-codex",
  ).pipe(
    Effect.timeout(PROBE_TIMEOUT_MS),
    Effect.orElseSucceed(() => undefined),
  );
  if (!token) return { limits: unsupported, email: undefined };

  const read = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(USAGE_URL).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("OpenAI-Beta", "codex-1"),
        HttpClientRequest.setHeader("Originator", "Codex Desktop"),
      ),
    );
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CodexUsage)),
    );
    const isMonthlyPlan = body.plan_type === "free" || body.plan_type === "go";
    const windows = [
      toWindow(
        "primary",
        body.rate_limit?.primary_window,
        isMonthlyPlan ? MONTH_MINS : SESSION_MINS,
      ),
      toWindow("secondary", body.rate_limit?.secondary_window, WEEK_MINS),
    ].filter((window): window is ServerProviderUsageWindow => window !== undefined);
    return {
      limits: makeUsageLimits({ checkedAt, windows }),
      email: body.email?.trim() || undefined,
    };
  });

  return yield* read.pipe(
    Effect.timeout(PROBE_TIMEOUT_MS),
    Effect.orElseSucceed(() => ({
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed" as const,
        message: "ChatGPT could not read usage.",
      }),
      email: undefined,
    })),
  );
});
