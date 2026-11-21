import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Effect from "effect/Effect";

import type { PiSettings } from "../settings.ts";

// Pi resolves credentials from its own agent directory and environment, so ask
// Pi for the value instead of re-deriving where `auth.json` lives.
export const readPiCredential = Effect.fn("PiUsageLimits.readCredential")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  command: "print-api-key" | "print-bearer-token",
  provider: string,
) {
  const binaryPath = settings.binaryPath || "pi";
  const spawnCommand = yield* resolveSpawnCommand(
    binaryPath,
    ["auth", command, "--provider", provider],
    { env: environment },
  );
  const output = yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
  if (output.code !== 0) return undefined;
  const value = output.stdout.trim();
  return value.length > 0 && !/\s/.test(value) ? value : undefined;
});
