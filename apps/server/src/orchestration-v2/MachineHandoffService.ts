// @effect-diagnostics-next-line nodeBuiltinImport:off -- Deterministic synchronous digests name retry-safe workspace paths.
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  MACHINE_HANDOFF_MAX_BYTES,
  MachineHandoffError,
  type MachineHandoffExportInput,
  MachineHandoffImportInput,
  type MachineHandoffImportResult,
  type MachineHandoffSnapshot,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { exportGitSnapshot, importGitSnapshot } from "./machineHandoffGit.ts";

export class MachineHandoffService extends Context.Service<
  MachineHandoffService,
  {
    readonly exportSnapshot: (
      input: MachineHandoffExportInput,
    ) => Effect.Effect<MachineHandoffSnapshot, MachineHandoffError>;
    readonly importSnapshot: (
      input: MachineHandoffImportInput,
    ) => Effect.Effect<MachineHandoffImportResult, MachineHandoffError>;
  }
>()("t3/orchestration-v2/MachineHandoffService") {}

const error = (cause: unknown) =>
  new MachineHandoffError({ message: cause instanceof Error ? cause.message : String(cause) });
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const importWarnings = [
  "The imported isolated worktree does not include ignored files, .env links, or installed dependencies copied into the destination project checkout. No setup scripts were executed. Run the destination project's trusted worktree setup before continuing.",
];
function assertBounded(snapshot: MachineHandoffSnapshot) {
  if (
    Buffer.byteLength(JSON.stringify(snapshot)) > MACHINE_HANDOFF_MAX_BYTES ||
    snapshot.context.length > 10_000
  )
    throw new Error("Machine handoff snapshot exceeds transfer limit");
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threadExecutor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const hostPlatform = yield* HostProcess.Platform;
  const encodeImport = Schema.encodeEffect(Schema.fromJsonString(MachineHandoffImportInput));
  const imports = yield* KeyedLock.make<string>();

  const exportSnapshot = Effect.fn("MachineHandoffService.exportSnapshot")(function* (
    input: MachineHandoffExportInput,
  ) {
    if (hostPlatform === "win32")
      return yield* new MachineHandoffError({
        message: "Machine handoff currently requires a POSIX host to preserve executable modes",
      });
    return yield* threadExecutor
      .withLock(
        input.threadId,
        Effect.gen(function* () {
          const { projection } = yield* threads.getThreadSnapshot(input.threadId);
          if (
            projection.thread.deletedAt !== null ||
            projection.runs.some((run) =>
              ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
            ) ||
            projection.runtimeRequests.some((request) => request.status === "pending") ||
            projection.providerThreads.some((thread) => thread.status === "active") ||
            projection.subagents.some((task) =>
              ["idle", "pending", "running", "waiting"].includes(task.status),
            ) ||
            projection.turnItems.some(
              (item) => item.status === "running" || item.status === "pending",
            )
          ) {
            return yield* new MachineHandoffError({
              message: "Stop live, queued, approval, and background work before machine handoff",
            });
          }
          const project = yield* projects.get(projection.thread.projectId);
          if (Option.isNone(project))
            return yield* new MachineHandoffError({ message: "Source project is unavailable" });
          const transcript = yield* threads
            .getThreadTranscript(input.threadId)
            .pipe(Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment));
          const context = transcript.items.flatMap((row) => {
            const message = historicalMessage(row.item);
            return message === null ? [] : [{ role: message.role, text: message.text }];
          });
          const snapshot: MachineHandoffSnapshot = {
            version: 1,
            sourceEnvironmentId: yield* environment.getEnvironmentId,
            sourceThreadId: input.threadId,
            title: projection.thread.title,
            runtimeMode: projection.thread.runtimeMode,
            interactionMode: projection.thread.interactionMode,
            modelSelection: projection.thread.modelSelection,
            branch: projection.thread.branch,
            workspaceKind: projection.thread.worktreePath === null ? "checkout" : "worktree",
            context,
            git: yield* Effect.tryPromise({
              try: () =>
                exportGitSnapshot(
                  projection.thread.worktreePath ?? project.value.workspaceRoot,
                  project.value.workspaceRoot,
                ),
              catch: error,
            }),
          };
          yield* Effect.try({ try: () => assertBounded(snapshot), catch: error });
          return snapshot;
        }),
      )
      .pipe(Effect.mapError(error));
  });

  const importSnapshot = Effect.fn("MachineHandoffService.importSnapshot")(function* (
    input: MachineHandoffImportInput,
  ) {
    if (hostPlatform === "win32")
      return yield* new MachineHandoffError({
        message: "Machine handoff currently requires a POSIX host to preserve executable modes",
      });
    yield* Effect.try({ try: () => assertBounded(input.snapshot), catch: error });
    return yield* imports
      .withLock(
        input.threadId,
        Effect.gen(function* () {
          const receipt = yield* receipts.getByCommandId(input.commandId);
          if (Option.isSome(receipt)) {
            if (
              receipt.value.status !== "accepted" ||
              receipt.value.threadId !== input.threadId ||
              receipt.value.commandType !== "thread.machine-import"
            )
              return yield* new MachineHandoffError({
                message: "Machine handoff retry identity is already used by another command",
              });
            return {
              threadId: receipt.value.threadId,
              sequence: receipt.value.resultSequence,
              warnings: importWarnings,
            };
          }
          const project = yield* projects.get(input.projectId);
          if (Option.isNone(project))
            return yield* new MachineHandoffError({
              message: "Clone and register the destination project before importing",
            });
          const directory = resolveWorktreesDirectory(
            (yield* settings.getSettings).worktreesDirectory,
            config.worktreesDir,
            path,
            home,
          );
          if (directory === null)
            return yield* new MachineHandoffError({
              message: "The destination worktrees directory must be absolute",
            });
          const target = path.join(
            directory,
            `machine-${digest(input.projectId).slice(0, 20)}`,
            `handoff-${digest(input.threadId).slice(0, 20)}`,
          );
          const marker = path.join(target, ".git");
          const identity = digest(yield* encodeImport(input));
          const completedMarker = path.join(
            directory,
            `machine-${digest(input.projectId).slice(0, 20)}`,
            `${digest(input.threadId)}.json`,
          );
          const prior = (yield* fs.exists(completedMarker))
            ? yield* fs.readFileString(completedMarker)
            : null;
          if (prior !== identity) {
            if (prior !== null)
              return yield* new MachineHandoffError({
                message: "Machine handoff destination belongs to a different import",
              });
            yield* Effect.tryPromise({
              try: () => importGitSnapshot(project.value.workspaceRoot, target, input.snapshot.git),
              catch: error,
            });
            yield* fs.writeFileString(completedMarker, identity, { flag: "wx" });
          } else {
            yield* fs.readFile(marker);
          }
          const result = yield* threads.dispatch({
            type: "thread.machine-import",
            commandId: input.commandId,
            threadId: input.threadId,
            projectId: input.projectId,
            createdBy: "user",
            creationSource: "server",
            title: input.snapshot.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.snapshot.runtimeMode,
            interactionMode: input.snapshot.interactionMode,
            branch: null,
            worktreePath: target,
            context: input.snapshot.context,
          });
          return { threadId: input.threadId, sequence: result.sequence, warnings: importWarnings };
        }),
      )
      .pipe(Effect.mapError(error));
  });
  return MachineHandoffService.of({ exportSnapshot, importSnapshot });
});
export const layer = Layer.effect(MachineHandoffService, make);
