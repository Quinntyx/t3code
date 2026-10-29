import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { readOpenCodeGoUsage } from "@t3tools/provider-core/server/opencodeGoUsage";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiSettings } from "../settings.ts";

const PROBE_TIMEOUT_MS = 5_000;

// Pi resolves credentials from its own agent directory and environment, so ask
// Pi for the key instead of re-deriving where `auth.json` lives.
const readPiApiKey = Effect.fn("PiUsageLimits.readApiKey")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "pi";
  const spawnCommand = yield* resolveSpawnCommand(
    command,
    ["auth", "print-api-key", "--provider", "opencode-go"],
    { env: environment },
  );
  const output = yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
  if (output.code !== 0) return undefined;
  const key = output.stdout.trim();
  return key.length > 0 && !/\s/.test(key) ? key : undefined;
});

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

    const apiKey = yield* readPiApiKey(input.settings, input.environment).pipe(
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
        return usage.limits;
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
