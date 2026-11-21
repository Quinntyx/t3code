// @effect-diagnostics nodeBuiltinImport:off -- Launch paths are derived synchronously at the provider boundary.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export function pycellsSocketPath(stateDir: string, threadId: string): string {
  const identity = JSON.stringify([NodePath.resolve(stateDir), threadId]);
  const digest = NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return NodePath.join("/tmp", `pi-pycells-${process.getuid?.() ?? "user"}`, `t3-${digest}.sock`);
}

export class PycellsLaunchError extends Schema.TaggedError<PycellsLaunchError>()(
  "PycellsLaunchError",
  { message: Schema.String },
) {}

export const PycellsLauncher = Context.Reference<{
  readonly prepare: (
    stateDir: string,
    threadId: string,
  ) => Effect.Effect<Record<string, string>, PycellsLaunchError>;
}>("@t3tools/shared/PycellsLauncher", {
  defaultValue: () => ({
    prepare: (stateDir, threadId) => Effect.succeed(pycellsLaunchEnvironment(stateDir, threadId)),
  }),
});

export function pycellsLaunchEnvironment(stateDir: string, threadId: string) {
  return {
    T3_THREAD_ID: threadId,
    T3_PYCELLS_SOCKET: pycellsSocketPath(stateDir, threadId),
    T3_PYCELLS_OWNER_PID: String(process.pid),
    T3_PYCELLS_LAUNCH_SOCKET: "",
  };
}
