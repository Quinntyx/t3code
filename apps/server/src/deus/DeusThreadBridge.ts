import * as NodeUtil from "node:util";
import {
  CommandId,
  DeusHumanTaskActionInput,
  DeusInputId,
  DeusStateError,
  MessageId,
  type DeusSessionRef,
  DeusTask,
  type DeusTaskLaunchInput,
  type DeusDescendant,
  type DeusWorkerReportInput,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { TaskActionPlan } from "./taskActionProtocol.ts";
import { PendingIntent as PendingIntentSchema } from "./decide.ts";
import * as Mcp from "../mcp/McpInvocationContext.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Intake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { invalidOptionSelections } from "../provider/validateModelOptions.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Sessions from "./DeusSessionService.ts";
import * as Repository from "./DeusRepository.ts";
import * as Authority from "./DeusAuthority.ts";
import type { PendingIntent } from "./decide.ts";

export class DeusBridgeError extends Schema.TaggedError<DeusBridgeError>()("DeusBridgeError", {
  cause: Schema.Defect(),
}) {}
type Failure =
  | DeusStateError
  | Repository.DeusRepositoryError
  | Authority.DeusAuthorityError
  | DeusBridgeError;
type WorkerRef = DeusSessionRef & { readonly threadId: ThreadId };
export interface DeusWorkerSnapshot {
  readonly threadId: ThreadId;
  readonly taskId: DeusTask["id"];
  readonly conversation: DeusTask["conversation"];
  readonly runId: RunId | null;
  readonly status: string;
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly runId: RunId | null;
    readonly role: string;
    readonly text: string;
  }>;
}
const scopeError = (message: string) => new DeusStateError({ reason: "scope-mismatch", message });
const externalError = (cause: unknown) => new DeusBridgeError({ cause });
const taskState = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      workers: DeusTask.fields.workers,
      descendants: DeusTask.fields.descendants,
      status: DeusTask.fields.status,
    }),
  ),
);
const rank = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };

export class DeusThreadBridge extends Context.Service<
  DeusThreadBridge,
  {
    readonly prepareAction: (
      input: typeof DeusHumanTaskActionInput.Type,
    ) => Effect.Effect<TaskActionPlan, Failure>;
    readonly executeAction: (
      plan: TaskActionPlan,
      reconcileOnly: boolean,
    ) => Effect.Effect<DeusTask, Failure>;
    readonly launch: (input: DeusTaskLaunchInput) => Effect.Effect<DeusTask, Failure>;
    readonly list: (ref: DeusSessionRef) => Effect.Effect<ReadonlyArray<DeusTask>, Failure>;
    readonly read: (ref: WorkerRef) => Effect.Effect<DeusWorkerSnapshot, Failure>;
    readonly workerScope: (scope: Mcp.McpInvocationScope) => Effect.Effect<DeusSessionRef, Failure>;
    readonly send: (
      input: WorkerRef & {
        readonly commandId: CommandId;
        readonly text: string;
        readonly mode: "queue" | "steer" | "auto";
      },
    ) => Effect.Effect<RunId, Failure>;
    readonly interrupt: (
      input: WorkerRef & { readonly commandId: CommandId; readonly runId: RunId },
    ) => Effect.Effect<void, Failure>;
    readonly reconcile: (ref: DeusSessionRef) => Effect.Effect<void, Failure>;
    readonly report: (
      scope: Mcp.McpInvocationScope,
      input: DeusWorkerReportInput,
    ) => Effect.Effect<void, Failure>;
    readonly recover: Effect.Effect<void, Failure>;
    readonly start: Effect.Effect<
      void,
      Failure,
      Scope.Scope | ApplicationEvents.OrchestrationEventStore
    >;
  }
>()("t3/deus/DeusThreadBridge") {}

const decodeLaunchIntent = Schema.decodeEffect(Schema.fromJsonString(PendingIntentSchema));
const make = Effect.gen(function* () {
  const intakeContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof Intake.sendToThread>>>();
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* Sessions.DeusSessionService;
  const repository = yield* Repository.DeusRepository;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const events = yield* Events.EventStoreV2;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* Adapters.ProviderAdapterRegistryV2;
  const authority = yield* Authority.DeusAuthority;
  const credentials = yield* McpProviderSessions;
  const reconciliation = yield* Semaphore.make(1);

  const selection = Effect.fn("DeusThreadBridge.selection")(function* (input: DeusTaskLaunchInput) {
    const providers = yield* registry.getProviders;
    const provider = providers.find((item) => item.instanceId === input.model.instanceId);
    if (
      !provider?.installed ||
      !provider.enabled ||
      provider.status !== "ready" ||
      !provider.models.some((item) => item.slug === input.model.model)
    )
      return yield* new DeusStateError({
        reason: "not-found",
        message: "Requested worker provider or model is unavailable.",
      });
    const invalid = invalidOptionSelections(
      input.model.options ?? [],
      provider.models.find((item) => item.slug === input.model.model)?.capabilities
        ?.optionDescriptors,
    );
    if (provider.auth.status === "unauthenticated" || invalid.length > 0)
      return yield* new DeusStateError({
        reason: "conflict",
        message: invalid.join(" ") || "Worker provider is not authenticated.",
      });
    yield* threads
      .assertProviderInstanceEnabled({
        projectId: input.projectId,
        commandId: CommandId.make(`deus:${input.inputId}`),
        instanceId: input.model.instanceId,
      })
      .pipe(Effect.mapError(externalError));
  });
  const authorize = Effect.fn("DeusThreadBridge.authorize")(function* (input: DeusTaskLaunchInput) {
    const grant = yield* authority.authorize(input);
    if (rank[input.runtimeMode] > rank[grant.runtimeMode])
      return yield* new Authority.DeusAuthorityError({ reason: "mode-limit" });
    if (input.workspace === "worktree" && !grant.allowWorktree)
      return yield* new Authority.DeusAuthorityError({ reason: "worktree-not-authorized" });
    return grant;
  });
  const owned = Effect.fn("DeusThreadBridge.owned")(function* (ref: WorkerRef) {
    const snapshot = yield* sessions.snapshot(ref);
    const task = snapshot.tasks.find((item) =>
      item.workers.some((worker) => worker.threadId === ref.threadId),
    );
    if (!task) return yield* scopeError("Thread is not registered to this Deus session.");
    const shell = yield* threads.getThreadShell(ref.threadId).pipe(Effect.mapError(externalError));
    if (!shell || shell.deletedAt !== null || shell.projectId !== ref.projectId)
      return yield* scopeError("Worker project identity changed.");
    return { task, shell };
  });
  const accepted = Effect.fn("DeusThreadBridge.accepted")(function* (
    pending: PendingIntent & {
      readonly intent: Extract<PendingIntent["intent"], { readonly type: "launch-thread" }>;
    },
  ) {
    const intent = pending.intent;
    const claim = yield* receipts
      .getByCommandId(intent.commandId)
      .pipe(Effect.mapError(externalError));
    const messageCommandId = CommandId.make(`${intent.commandId}:initial-message`);
    const message = yield* receipts
      .getByCommandId(messageCommandId)
      .pipe(Effect.mapError(externalError));
    for (const [receipt, type] of [
      [claim, "thread.create"],
      [message, "message.dispatch"],
    ] as const) {
      if (
        Option.isSome(receipt) &&
        (receipt.value.threadId !== intent.threadId ||
          receipt.value.status !== "accepted" ||
          receipt.value.commandType !== type)
      )
        return yield* scopeError("Worker launch receipt is incompatible with its durable intent.");
    }
    const shell = yield* threads
      .getThreadShell(intent.threadId)
      .pipe(Effect.mapError(externalError));
    if (shell && (shell.projectId !== pending.projectId || shell.creationSource !== "deus"))
      return yield* scopeError("Worker thread is incompatible with its durable intent.");
    if (Option.isNone(message)) return null;
    if (Option.isNone(claim) || !shell)
      return yield* scopeError("Accepted worker message has no matching launch.");
    const stored = yield* events
      .readByCommandId({ commandId: messageCommandId })
      .pipe(Stream.runCollect, Effect.mapError(externalError));
    const created = stored.find((item) => item.event.type === "run.created");
    if (created?.event.type !== "run.created" || created.event.threadId !== intent.threadId)
      return yield* scopeError("Accepted worker message has no original durable run.");
    return created.event.payload.id;
  });
  const execute = Effect.fn("DeusThreadBridge.execute")(function* (pending: PendingIntent) {
    if (pending.intent.type !== "launch-thread") return;
    const intent = pending.intent;
    yield* sessions.snapshot(pending);
    let runId = yield* accepted({ ...pending, intent });
    if (runId === null) {
      yield* selection(intent.input);
      const grant = yield* authorize(intent.input);
      const project = yield* threads
        .getThreadShell(intent.threadId)
        .pipe(Effect.mapError(externalError));
      if (
        project &&
        (project.runtimeMode !== intent.input.runtimeMode ||
          project.modelSelection.instanceId !== intent.input.model.instanceId ||
          project.modelSelection.model !== intent.input.model.model)
      )
        return yield* scopeError("Partial launch authority or model differs from the intent.");
      yield* launches
        .launch({
          commandId: intent.commandId,
          threadId: intent.threadId,
          projectId: pending.projectId,
          title: intent.input.prompt,
          modelSelection: intent.input.model,
          runtimeMode: intent.input.runtimeMode,
          interactionMode: intent.input.kind === "research" ? "plan" : grant.interactionMode,
          workspaceStrategy:
            intent.input.workspace === "project"
              ? { type: "root" }
              : { type: "worktree", baseRef: "HEAD", startFromOrigin: false },
          initialMessage: { text: intent.input.prompt, attachments: [] },
          createdBy: "agent",
          creationSource: "deus",
        })
        .pipe(Effect.provideService(DispatchModeLimit, grant), Effect.mapError(externalError));
      runId = yield* accepted({ ...pending, intent });
      if (runId === null) return yield* scopeError("Worker launch was not durably accepted.");
    }
    yield* sessions.acknowledgeLaunch({
      ...pending,
      inputId: DeusInputId.make(`${pending.inputId}:ack`),
      taskId: intent.taskId,
      threadId: intent.threadId,
      commandId: intent.commandId,
      runId,
    });
  });
  const resolveOwner = Effect.fn("DeusThreadBridge.resolveOwner")(function* (threadId: ThreadId) {
    const visited = new Set<ThreadId>();
    let current = threadId;
    while (visited.size < 64 && !visited.has(current)) {
      visited.add(current);
      const registered = yield* repository.findWorker(current);
      if (registered) return { ...registered, rootThreadId: current };
      const shell = yield* threads.getThreadShell(current).pipe(Effect.mapError(externalError));
      const parentId = shell?.lineage.parentThreadId;
      if (!shell || !parentId) return null;
      const parent = yield* threads
        .getThreadRecords(parentId, ["subagents"])
        .pipe(Effect.mapError(externalError));
      if (
        parent.thread.projectId !== shell.projectId ||
        !parent.subagents.some((child) => child.childThreadId === current)
      )
        return null;
      current = parentId;
    }
    return null;
  });
  const reconcile = Effect.fn("DeusThreadBridge.reconcile")(function* (ref: DeusSessionRef) {
    const snapshot = yield* sessions.snapshot(ref);
    for (const task of snapshot.tasks) {
      const descendants: DeusDescendant[] = [];
      const workers: DeusTask["workers"][number][] = [];
      const queue = [
        ...new Set(
          task.workers
            .filter((worker) => worker.parentThreadId === null)
            .map((worker) => worker.threadId),
        ),
      ];
      const seen = new Set<ThreadId>();
      const rootStatuses: string[] = [];
      const childStatuses: string[] = [];
      while (queue.length > 0 && seen.size < 128) {
        const threadId = queue.shift()!;
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(externalError));
        if (
          !shell &&
          task.workers.some((worker) => worker.threadId === threadId && worker.runId === null)
        )
          continue;
        const records = yield* threads
          .getThreadRecords(threadId, ["runs", "subagents", "runtimeRequests"])
          .pipe(Effect.mapError(externalError));
        if (records.thread.projectId !== ref.projectId)
          return yield* scopeError("Descendant escaped its Deus project.");
        const prior = task.workers.find((worker) => worker.threadId === threadId);
        for (const run of records.runs) {
          const turns = yield* adapters.get(run.providerInstanceId).pipe(
            Effect.flatMap((adapter) => adapter.getCapabilities()),
            Effect.map((capabilities) => capabilities.turns),
            Effect.orElseSucceed(() => null),
          );
          workers.push({
            status: run.status,
            previousRunId:
              records.runs.find((item) => item.ordinal === run.ordinal - 1)?.id ?? null,
            pendingApprovals:
              shell?.activeRunId === run.id
                ? records.runtimeRequests.filter((request) => request.status === "pending").length
                : 0,
            operations: {
              steer:
                !!turns &&
                (turns.supportsActiveSteering || turns.supportsSteeringByInterruptRestart),
              interrupt: turns?.supportsInterrupt ?? false,
              queue: turns?.supportsQueuedMessages ?? false,
            },
            threadId,
            runId: run.id,
            parentTaskId: prior?.parentTaskId ?? null,
            parentThreadId: prior?.parentThreadId ?? records.thread.lineage.parentThreadId ?? null,
            model: run.modelSelection,
            runtimeMode: records.thread.runtimeMode,
          });
        }
        const latest = records.runs.reduce<(typeof records.runs)[number] | undefined>(
          (current, run) => (!current || run.ordinal > current.ordinal ? run : current),
          undefined,
        );
        if (latest) {
          if (records.thread.lineage.parentThreadId === null) rootStatuses.push(latest.status);
          else childStatuses.push(latest.status);
        }
        for (const child of records.subagents) {
          descendants.push({
            id: child.id,
            threadId: child.threadId,
            runId: child.runId,
            origin: child.origin,
            childThreadId: child.childThreadId,
            nativeTaskRef: child.nativeTaskRef,
            status: child.status,
          });
          if (child.childThreadId) {
            const shell = yield* threads
              .getThreadShell(child.childThreadId)
              .pipe(Effect.mapError(externalError));
            if (
              !shell ||
              shell.projectId !== ref.projectId ||
              shell.lineage.parentThreadId !== threadId
            )
              return yield* scopeError("Descendant ancestry is incompatible.");
            queue.push(child.childThreadId);
          }
        }
      }
      if (queue.length > 0) return yield* scopeError("Worker descendant limit exceeded.");
      if (workers.length === 0) continue;
      const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
      const liveRoot = rootStatuses.some((status) => !terminal.has(status));
      const liveChild =
        descendants.some((child) => !terminal.has(child.status)) ||
        childStatuses.some((status) => !terminal.has(status));
      const status = liveRoot
        ? "running"
        : liveChild
          ? "waiting"
          : rootStatuses.includes("failed")
            ? "failed"
            : rootStatuses.some((item) =>
                  ["cancelled", "interrupted", "rolled_back"].includes(item),
                )
              ? "cancelled"
              : "completed";
      const next = { ...task, workers, descendants, status } as const;
      if (
        taskState({
          workers: task.workers,
          descendants: task.descendants ?? [],
          status: task.status,
        }) === taskState({ workers, descendants, status })
      )
        continue;
      const sequence = yield* events.latestSequence().pipe(Effect.mapError(externalError));
      yield* repository.commit({
        type: "synchronize-task",
        input: {
          ...ref,
          inputId: DeusInputId.make(`deus-sync:${task.id}:${snapshot.cursor}:${sequence}`),
          task: next,
        },
      });
    }
  }, reconciliation.withPermits(1));
  const recover = Effect.gen(function* () {
    for (const pending of yield* sessions.pending) {
      if (pending.intent.type === "launch-thread")
        yield* execute(pending).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Deus launch retained for reconciliation", {
              inputId: pending.inputId,
              error,
            }),
          ),
        );
    }
    for (const ref of yield* repository.workerSessions) yield* reconcile(ref);
  }).pipe(Effect.withSpan("DeusThreadBridge.recover"));
  const launch = Effect.fn("DeusThreadBridge.launch")(function* (input: DeusTaskLaunchInput) {
    const current = yield* sessions.snapshot(input);
    if (!current.tasks.some((task) => task.inputId === input.inputId)) {
      yield* selection(input);
      yield* authorize(input);
    }
    const prepared = yield* sessions.prepareLaunch(input);
    const pending = (yield* sessions.pending).find(
      (item) => item.sessionId === input.sessionId && item.inputId === input.inputId,
    );
    if (pending) yield* execute(pending);
    yield* reconcile(input);
    return (yield* sessions.snapshot(input)).tasks.find((task) => task.id === prepared.task.id)!;
  });
  return DeusThreadBridge.of({
    prepareAction: Effect.fn("DeusThreadBridge.prepareAction")(function* (input) {
      yield* authority.authorize(input);
      const task = (yield* sessions.snapshot(input)).tasks.find((item) => item.id === input.taskId);
      const worker = task?.workers.find((item) => item.parentThreadId === null);
      if (!task || !worker) return yield* scopeError("Task has no registered root worker.");
      const { shell } = yield* owned({ ...input, threadId: worker.threadId });
      const rows = yield* sql<{
        intent_json: string;
      }>`SELECT intent_json FROM deus_outbox WHERE session_id = ${input.sessionId}
        AND json_extract(intent_json, '$.intent.type') = 'launch-thread'
        AND json_extract(intent_json, '$.intent.taskId') = ${task.id}`.pipe(
        Effect.mapError(externalError),
      );
      if (!rows[0]) return yield* scopeError("Task has no original launch intent.");
      const launch = yield* decodeLaunchIntent(rows[0].intent_json).pipe(
        Effect.mapError(externalError),
      );
      if (launch.intent.type !== "launch-thread")
        return yield* scopeError("Task launch is invalid.");
      const history = yield* events
        .readByCommandId({ commandId: launch.intent.commandId })
        .pipe(Stream.runCollect, Effect.mapError(externalError));
      const created = history.find((item) => item.event.type === "thread.created")?.event;
      if (created?.type !== "thread.created" || created.threadId !== worker.threadId)
        return yield* scopeError("Task has no original worker creation evidence.");
      const original = created.payload;
      if (
        !NodeUtil.isDeepStrictEqual(shell.modelSelection, original.modelSelection) ||
        shell.worktreePath !== original.worktreePath ||
        rank[shell.runtimeMode] > rank[original.runtimeMode] ||
        (original.interactionMode === "plan" && shell.interactionMode !== "plan")
      )
        return yield* scopeError("Worker settings exceed or differ from the original launch.");
      const records = yield* threads
        .getThreadRecords(worker.threadId, ["runs"])
        .pipe(Effect.mapError(externalError));
      const run = records.runs.reduce<(typeof records.runs)[number] | undefined>(
        (current, item) => (!current || item.ordinal > current.ordinal ? item : current),
        undefined,
      );
      if (!run) return yield* scopeError("Task has no original worker run.");
      const kind = input.action.type;
      let text = "text" in input.action ? (input.action.text ?? null) : null;
      if (kind === "retry") {
        if (!["failed", "cancelled", "interrupted"].includes(run.status) || shell.activeRunId)
          return yield* new DeusStateError({
            reason: "conflict",
            message: "Retry requires a stopped failed or interrupted worker run.",
          });
        const source = yield* threads
          .getThreadRecords(worker.threadId, ["messages"], { runIds: [run.id] })
          .pipe(Effect.mapError(externalError));
        const message = source.messages.find(
          (item) => item.runId === run.id && item.role === "user",
        );
        if (
          !message ||
          message.attachments.length ||
          !message.text.trim() ||
          message.text.length > 8000
        )
          return yield* new DeusStateError({
            reason: "conflict",
            message:
              "Retry requires one bounded original text-only worker request; send explicit direction otherwise.",
          });
        text = message.text;
      }
      if (
        kind === "continue" &&
        (!text ||
          shell.activeRunId ||
          !["completed", "failed", "cancelled", "interrupted"].includes(run.status))
      )
        return yield* new DeusStateError({
          reason: "conflict",
          message: "Continue requires explicit human text and a stopped worker run.",
        });
      if (text && text.length > 8000)
        return yield* new DeusStateError({
          reason: "conflict",
          message: "Task action text exceeds 8000 characters.",
        });
      if ((kind === "steer" || kind === "interrupt") && !shell.activeRunId)
        return yield* new DeusStateError({
          reason: "conflict",
          message: `${kind === "steer" ? "Steer" : "Interrupt"} requires an active worker run.`,
        });
      return {
        type: "task-action",
        input,
        task,
        threadId: worker.threadId,
        runId: kind === "interrupt" ? shell.activeRunId : run.id,
        commandId: CommandId.make(`deus-action:${input.sessionId}:${input.inputId}`),
        model: original.modelSelection,
        runtimeMode: original.runtimeMode,
        interactionMode: original.interactionMode,
        worktreePath: original.worktreePath,
        dispatchMode:
          kind === "queue"
            ? { type: "queue_after_active" }
            : (kind === "steer" || kind === "send") && shell.activeRunId
              ? { type: "steer_active", targetRunId: shell.activeRunId }
              : { type: "start_immediately" },
        text,
        query: null,
      };
    }),
    executeAction: Effect.fn("DeusThreadBridge.executeAction")(function* (plan, reconcileOnly) {
      const { input } = plan;
      yield* sessions.snapshot(input);
      let receipt = yield* receipts
        .getByCommandId(plan.commandId)
        .pipe(Effect.mapError(externalError));
      const expected = input.action.type === "interrupt" ? "run.interrupt" : "message.dispatch";
      if (Option.isNone(receipt)) {
        if (reconcileOnly) return yield* new Authority.DeusAuthorityError({ reason: "inactive" });
        const grant = yield* authority.authorize(input);
        const { shell } = yield* owned({ ...input, threadId: plan.threadId });
        if (
          rank[shell.runtimeMode] > rank[plan.runtimeMode] ||
          rank[shell.runtimeMode] > rank[grant.runtimeMode] ||
          (shell.interactionMode === "default" &&
            (grant.interactionMode === "plan" || plan.interactionMode === "plan")) ||
          shell.worktreePath !== plan.worktreePath ||
          !NodeUtil.isDeepStrictEqual(shell.modelSelection, plan.model) ||
          (shell.worktreePath !== null && (!input.authority.allowWorktree || !grant.allowWorktree))
        )
          return yield* new Authority.DeusAuthorityError({ reason: "mode-limit" });
        const limit = {
          runtimeMode:
            rank[plan.runtimeMode] < rank[input.authority.runtimeMode]
              ? plan.runtimeMode
              : input.authority.runtimeMode,
          interactionMode:
            plan.interactionMode === "plan" || input.authority.interactionMode === "plan"
              ? ("plan" as const)
              : ("default" as const),
        };
        if (input.action.type === "interrupt") {
          if (!plan.runId) return yield* scopeError("Action has no captured run.");
          yield* threads
            .interruptThread({
              projectId: input.projectId,
              threadId: plan.threadId,
              runId: plan.runId,
              commandId: plan.commandId,
            })
            .pipe(Effect.mapError(externalError));
        } else {
          if (!plan.text) return yield* scopeError("Action has no captured human request.");
          yield* Intake.dispatchCommand({
            type: "message.dispatch",
            commandId: plan.commandId,
            threadId: plan.threadId,
            messageId: MessageId.make(`deus-action:${plan.commandId}`),
            text: plan.text,
            attachments: [],
            modelSelection: plan.model,
            dispatchMode: plan.dispatchMode,
            createdBy: "user",
            creationSource: "deus",
          }).pipe(
            Effect.provide(intakeContext),
            Effect.provideService(DispatchModeLimit, limit),
            Effect.mapError(externalError),
          );
        }
        receipt = yield* receipts
          .getByCommandId(plan.commandId)
          .pipe(Effect.mapError(externalError));
      }
      if (
        Option.isNone(receipt) ||
        receipt.value.threadId !== plan.threadId ||
        receipt.value.status !== "accepted" ||
        receipt.value.commandType !== expected
      )
        return yield* scopeError("Task action receipt is incompatible with its original intent.");
      const stored = yield* events
        .readByCommandId({ commandId: plan.commandId })
        .pipe(Stream.runCollect, Effect.mapError(externalError));
      const message = stored.find((item) => item.event.type === "message.updated")?.event;
      if (
        input.action.type !== "interrupt" &&
        (message?.type !== "message.updated" ||
          message.threadId !== plan.threadId ||
          message.payload.id !== `deus-action:${plan.commandId}` ||
          message.payload.text !== plan.text ||
          !message.payload.runId)
      )
        return yield* scopeError("Task action has no matching original durable message/run.");
      const runId = message?.type === "message.updated" ? message.payload.runId : plan.runId;
      const worker = plan.task.workers.find((item) => item.threadId === plan.threadId)!;
      return {
        ...plan.task,
        workers:
          runId &&
          !plan.task.workers.some((item) => item.threadId === plan.threadId && item.runId === runId)
            ? [...plan.task.workers, { ...worker, runId }]
            : plan.task.workers,
      };
    }),
    launch,
    reconcile,
    report: Effect.fn("DeusThreadBridge.report")(function* (scope, input) {
      if (!scope.thread || scope.client || !scope.capabilities.has("orchestration"))
        return yield* scopeError("Worker reports require an authenticated thread caller.");
      const credential = yield* credentials.read(scope.thread.threadId);
      if (
        !credential ||
        credential.environmentId !== scope.environmentId ||
        credential.threadId !== scope.thread.threadId ||
        credential.providerInstanceId !== scope.thread.providerInstanceId ||
        credential.providerSessionId !== scope.thread.providerSessionId
      )
        return yield* scopeError("Report credential no longer owns this worker provider session.");
      const ref = yield* resolveOwner(scope.thread.threadId);
      if (!ref || ref.environmentId !== scope.environmentId)
        return yield* scopeError("Reporting thread is not a Deus worker.");
      const records = yield* threads
        .getThreadRecords(scope.thread.threadId, ["runs", "subagents"], { runIds: [input.runId] })
        .pipe(Effect.mapError(externalError));
      const run = records.runs.find(
        (run) =>
          run.id === input.runId &&
          run.threadId === scope.thread!.threadId &&
          run.providerInstanceId === scope.thread!.providerInstanceId,
      );
      if (
        records.thread.deletedAt !== null ||
        records.thread.projectId !== ref.projectId ||
        !run ||
        (run.completedAt !== null && DateTime.toEpochMillis(run.completedAt) < scope.issuedAt)
      )
        return yield* scopeError(
          "Report run does not belong to the authenticated worker provider session.",
        );
      if (
        input.subagentId !== undefined &&
        !records.subagents.some(
          (child) =>
            child.id === input.subagentId &&
            child.threadId === scope.thread!.threadId &&
            child.runId === input.runId &&
            child.providerInstanceId === scope.thread!.providerInstanceId,
        )
      )
        return yield* scopeError(
          "Report native subagent does not belong to the authenticated run.",
        );
      for (const pending of yield* sessions.pending)
        if (
          pending.sessionId === ref.sessionId &&
          pending.intent.type === "launch-thread" &&
          pending.intent.threadId === ref.rootThreadId
        )
          yield* execute(pending);
      yield* reconcile(ref);
      const snapshot = yield* sessions.snapshot(ref);
      const task = snapshot.tasks.find((item) =>
        item.workers.some(
          (worker) => worker.threadId === scope.thread!.threadId && worker.runId === input.runId,
        ),
      );
      if (!task) return yield* scopeError("Report has no registered task ancestry.");
      yield* sessions.recordReport({
        ...ref,
        ...input,
        taskId: task.id,
        threadId: scope.thread.threadId,
      });
    }),
    start: Effect.gen(function* () {
      const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore;
      const afterSequence = yield* applicationEvents.latestApplicationSequence.pipe(
        Effect.mapError(externalError),
      );
      yield* recover;
      yield* applicationEvents
        .streamProjectedApplicationEvents({
          afterSequence,
          project: (event) => event,
          filter: (event) =>
            "event" in event &&
            ["run.updated", "run.created", "subagent.updated", "runtime-request.updated"].includes(
              event.event.type,
            ),
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (!("event" in event)) return;
              const ref = yield* resolveOwner(event.event.threadId);
              if (ref) yield* reconcile(ref);
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Deus worker reconciliation deferred", { error }),
              ),
            ),
          ),
          Effect.orDie,
          Effect.forkScoped,
        );
    }),
    workerScope: Effect.fn("DeusThreadBridge.workerScope")(function* (scope) {
      if (!scope.thread || scope.client)
        return yield* scopeError("Only authenticated Deus workers can inspect worker evidence.");
      const credential = yield* credentials.read(scope.thread.threadId);
      if (
        !credential ||
        credential.environmentId !== scope.environmentId ||
        credential.providerInstanceId !== scope.thread.providerInstanceId ||
        credential.providerSessionId !== scope.thread.providerSessionId
      )
        return yield* scopeError("Worker credential no longer owns this provider session.");
      const ref = yield* resolveOwner(scope.thread.threadId);
      if (!ref || ref.environmentId !== scope.environmentId)
        return yield* scopeError("Calling thread is not a Deus worker.");
      yield* owned({ ...ref, threadId: scope.thread.threadId });
      return ref;
    }),
    list: Effect.fn("DeusThreadBridge.list")(function* (ref) {
      return (yield* sessions.snapshot(ref)).tasks;
    }),
    read: Effect.fn("DeusThreadBridge.read")(function* (ref) {
      const { task, shell } = yield* owned(ref);
      const window = yield* threads
        .getThreadSnapshotWindow(ref.threadId, { rowLimit: 32 })
        .pipe(Effect.mapError(externalError));
      const run = window.projection.runs.reduce<
        (typeof window.projection.runs)[number] | undefined
      >(
        (current, candidate) =>
          !current || candidate.ordinal > current.ordinal ? candidate : current,
        undefined,
      );
      const messages = Object.freeze(
        window.projection.messages
          .filter((message) => run !== undefined && message.runId === run.id)
          .slice(-32)
          .map((message) =>
            Object.freeze({
              id: message.id,
              runId: message.runId,
              role: message.role,
              text: message.text.slice(0, 256),
            }),
          ),
      );
      return Object.freeze({
        threadId: ref.threadId,
        taskId: task.id,
        conversation: task.conversation,
        runId: run?.id ?? null,
        status: run?.status ?? shell.status,
        messages,
      });
    }),
    send: Effect.fn("DeusThreadBridge.send")(function* (input) {
      const { task, shell } = yield* owned(input);
      const grant = yield* authority.authorize(input);
      if (
        rank[shell.runtimeMode] > rank[grant.runtimeMode] ||
        (shell.interactionMode === "default" && grant.interactionMode === "plan")
      )
        return yield* new Authority.DeusAuthorityError({ reason: "mode-limit" });
      const result = yield* Intake.sendToThread({
        projectId: input.projectId,
        threadId: input.threadId,
        commandId: input.commandId,
        messageId: MessageId.make(`deus:${task.id}:${input.commandId}`),
        text: input.text,
        attachments: [],
        mode: input.mode,
        createdBy: "agent",
        creationSource: "deus",
      }).pipe(
        Effect.provide(intakeContext),
        Effect.provideService(DispatchModeLimit, grant),
        Effect.mapError(externalError),
      );
      return result.run.id;
    }),
    interrupt: Effect.fn("DeusThreadBridge.interrupt")(function* (input) {
      yield* owned(input);
      yield* authority.authorize(input);
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs"], { runIds: [input.runId] })
        .pipe(Effect.mapError(externalError));
      if (!records.runs.some((run) => run.id === input.runId && run.threadId === input.threadId))
        return yield* scopeError("Interrupt run does not belong to the worker.");
      yield* threads
        .interruptThread({
          projectId: input.projectId,
          threadId: input.threadId,
          commandId: input.commandId,
          runId: input.runId,
        })
        .pipe(Effect.mapError(externalError));
    }),
    recover,
  });
});
export const layer = Layer.effect(DeusThreadBridge, make);
