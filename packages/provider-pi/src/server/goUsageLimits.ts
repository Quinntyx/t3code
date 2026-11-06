import { ProviderDriverKind, type ServerProviderUsageLimits } from "@t3tools/contracts";
import { readOpenCodeGoUsage } from "@t3tools/provider-core/server/opencodeGoUsage";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PiSettings } from "../settings.ts";
import { readPiCredential } from "./piCredentials.ts";

const PROBE_TIMEOUT_MS = 5_000;

export const readPiOpenCodeGoUsageLimits = Effect.fn("readPiOpenCodeGoUsageLimits")(
  function* (input: {
    readonly enabled: boolean;
    readonly settings: PiSettings;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ServerProviderUsageLimits,
    never,
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | Crypto.Crypto
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    if (!input.enabled) return unsupported;

    const apiKey = yield* readPiCredential(
      input.settings,
      input.environment,
      "print-api-key",
      "opencode-go",
    ).pipe(
      Effect.timeout(PROBE_TIMEOUT_MS),
      Effect.orElseSucceed(() => undefined),
    );
    if (!apiKey) return unsupported;

    const usage = yield* readOpenCodeGoUsage({ apiKey, checkedAt }).pipe(
      Effect.timeout(PROBE_TIMEOUT_MS),
      Effect.orElseSucceed(() => ({ _tag: "failed" }) as const),
    );
    switch (usage._tag) {
      case "limits":
        // Pi reads OpenCode's Go login, so Pi and an OpenCode instance share one subscription.
        return { ...usage.limits, ownerDriver: ProviderDriverKind.make("opencode") };
      case "noSubscription":
        return unsupported;
      case "failed":
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "OpenCode Go could not read usage.",
        });
    }
  },
);
