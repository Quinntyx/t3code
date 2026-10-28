import {
  CommandId,
  DeusConversation,
  DeusCursor,
  DeusInput,
  DeusInputId,
  DeusInputReceipt,
  DeusResetConversationInput,
  DeusSessionRef,
  DeusSnapshot,
  DeusStateError,
  DeusTask,
  DeusTaskId,
  DeusTaskLaunchInput,
  DeusTranscriptId,
  RunId,
  ThreadId,
  type DeusDurableChange,
  type IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const LaunchAcknowledgment = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  taskId: DeusTaskId,
  threadId: ThreadId,
  commandId: CommandId,
  runId: RunId,
});
export type LaunchAcknowledgment = typeof LaunchAcknowledgment.Type;
export const TaskReport = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  taskId: DeusTaskId,
  threadId: ThreadId,
  runId: RunId,
  mode: Schema.Literals(["SILENT", "WHEN_IDLE", "INTERRUPT"]),
  text: Schema.Trimmed.check(Schema.isMinLength(1)),
});
export type TaskReport = typeof TaskReport.Type;
export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("input"), input: DeusInput }),
  Schema.Struct({ type: Schema.Literal("reset"), input: DeusResetConversationInput }),
  Schema.Struct({ type: Schema.Literal("launch"), input: DeusTaskLaunchInput }),
  Schema.Struct({ type: Schema.Literal("acknowledge-launch"), input: LaunchAcknowledgment }),
  Schema.Struct({ type: Schema.Literal("report"), input: TaskReport }),
]);
export type Command = typeof Command.Type;
export const Intent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("coordinate-input"), input: DeusInput }),
  Schema.Struct({
    type: Schema.Literal("launch-thread"),
    input: DeusTaskLaunchInput,
    taskId: DeusTaskId,
    threadId: ThreadId,
    commandId: CommandId,
  }),
]);
export type Intent = typeof Intent.Type;
export const PendingIntent = Schema.Struct({
  ...DeusSessionRef.fields,
  cursor: DeusCursor,
  inputId: DeusInputId,
  intent: Intent,
});
export type PendingIntent = typeof PendingIntent.Type;
export const CommandResult = Schema.Struct({
  receipt: DeusInputReceipt,
  task: Schema.optional(DeusTask),
});
export type CommandResult = typeof CommandResult.Type;

export function decide(
  snapshot: DeusSnapshot,
  command: Command,
  now: IsoDateTime,
  ids: {
    readonly transcriptId: DeusTranscriptId;
    readonly taskId: DeusTaskId;
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
  },
):
  | { readonly changes: ReadonlyArray<DeusDurableChange>; readonly intent?: Intent }
  | DeusStateError {
  const { input } = command;
  if ("conversation" in input && input.conversation !== snapshot.session.conversation) {
    return new DeusStateError({ reason: "conflict", message: "The conversation has changed." });
  }
  switch (command.type) {
    case "input":
      return {
        changes: [
          {
            type: "transcript",
            transcript: {
              id: ids.transcriptId,
              conversation: command.input.conversation,
              inputId: input.inputId,
              role: "human",
              text: command.input.text,
              createdAt: now,
            },
          },
        ],
        intent: { type: "coordinate-input", input: command.input },
      };
    case "reset":
      return {
        changes: [
          {
            type: "conversation-reset",
            conversation: DeusConversation.make(snapshot.session.conversation + 1),
          },
        ],
      };
    case "launch":
      return {
        changes: [
          {
            type: "task",
            task: {
              id: ids.taskId,
              inputId: input.inputId,
              conversation: command.input.conversation,
              title: command.input.prompt,
              status: "pending",
              workers: [
                {
                  threadId: ids.threadId,
                  runId: null,
                  parentTaskId: null,
                  parentThreadId: null,
                  model: command.input.model,
                  runtimeMode: command.input.runtimeMode,
                },
              ],
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
        intent: {
          type: "launch-thread",
          input: command.input,
          taskId: ids.taskId,
          threadId: ids.threadId,
          commandId: ids.commandId,
        },
      };
    case "acknowledge-launch": {
      const task = snapshot.tasks.find((item) => item.id === command.input.taskId);
      if (
        !task ||
        !task.workers.some(
          (worker) =>
            worker.threadId === command.input.threadId &&
            (worker.runId === null || worker.runId === command.input.runId),
        )
      ) {
        return new DeusStateError({
          reason: "scope-mismatch",
          message: "Worker does not belong to this task.",
        });
      }
      return {
        changes: [
          {
            type: "task",
            task: {
              ...task,
              status: "running",
              updatedAt: now,
              workers: task.workers.map((worker) =>
                worker.threadId === command.input.threadId
                  ? { ...worker, runId: command.input.runId }
                  : worker,
              ),
            },
          },
        ],
      };
    }
    case "report": {
      const task = snapshot.tasks.find((item) => item.id === command.input.taskId);
      if (
        !task?.workers.some(
          (worker) =>
            worker.threadId === command.input.threadId && worker.runId === command.input.runId,
        )
      ) {
        return new DeusStateError({
          reason: "scope-mismatch",
          message: "Report does not match a recorded worker run.",
        });
      }
      return {
        changes: [
          {
            type: "report",
            report: {
              cursor: DeusCursor.make(snapshot.cursor + 1),
              taskId: task.id,
              threadId: command.input.threadId,
              runId: command.input.runId,
              mode: command.input.mode,
              text: command.input.text,
              createdAt: now,
            },
          },
        ],
      };
    }
  }
}

export function project(
  snapshot: DeusSnapshot,
  change: DeusDurableChange,
  now: IsoDateTime,
): DeusSnapshot {
  const next = {
    ...snapshot,
    cursor: DeusCursor.make(snapshot.cursor + 1),
    session: { ...snapshot.session, updatedAt: now },
  };
  switch (change.type) {
    case "conversation-reset":
      return { ...next, session: { ...next.session, conversation: change.conversation } };
    case "transcript":
      return { ...next, transcripts: [...next.transcripts, change.transcript] };
    case "task":
      return {
        ...next,
        tasks: [...next.tasks.filter((task) => task.id !== change.task.id), change.task],
      };
    case "report":
      return { ...next, reports: [...next.reports, change.report] };
    case "observation":
      return {
        ...next,
        observations: [
          ...next.observations.filter((item) => item.id !== change.observation.id),
          change.observation,
        ],
      };
    case "memory":
      return {
        ...next,
        memories: [...next.memories.filter((item) => item.id !== change.memory.id), change.memory],
      };
    case "ponder":
      return {
        ...next,
        ponderReceipts: [
          ...next.ponderReceipts.filter((item) => item.id !== change.receipt.id),
          change.receipt,
        ],
      };
  }
}
