import {
  CommandId,
  DeusConversation,
  DeusCursor,
  DeusInput,
  DeusInputId,
  DeusInputReceipt,
  DeusLiveOrigin,
  DeusObservationId,
  DeusDelta,
  DeusResetConversationInput,
  DeusSessionRef,
  DeusSnapshot,
  DeusStateError,
  DeusTask,
  DeusTaskId,
  DeusTaskLaunchInput,
  DeusTranscriptId,
  NodeId,
  RunId,
  ThreadId,
  type DeusDurableChange,
  type IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Continuation, TextFailureCode } from "./textProtocol.ts";

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
  subagentId: Schema.optional(NodeId),
  mode: Schema.Literals(["SILENT", "WHEN_IDLE", "INTERRUPT"]),
  text: Schema.Trimmed.check(Schema.isMinLength(1)),
});
export type TaskReport = typeof TaskReport.Type;
export const ObservationInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  sourceCursor: DeusCursor,
  kind: Schema.Literals(["context", "correction", "proposed-preference", "speculation"]),
  text: Schema.Trimmed.check(Schema.isMinLength(1)),
  supersedes: Schema.NullOr(DeusObservationId),
});
export type ObservationInput = typeof ObservationInput.Type;
export const SpokenInput = Schema.Struct({ ...DeusInput.fields, origin: DeusLiveOrigin });
export type SpokenInput = typeof SpokenInput.Type;
export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("spoken-input"), input: SpokenInput }),
  Schema.Struct({
    type: Schema.Literal("report-response"),
    input: Schema.Struct({
      ...DeusSessionRef.fields,
      inputId: DeusInputId,
      sourceCursor: DeusCursor,
      origin: DeusLiveOrigin,
      text: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("respond"),
    input: Schema.Struct({
      ...DeusSessionRef.fields,
      inputId: DeusInputId,
      humanInputId: DeusInputId,
      conversation: DeusConversation,
      text: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
      error: Schema.optional(TextFailureCode),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("observe"), input: ObservationInput }),
  Schema.Struct({ type: Schema.Literal("input"), input: DeusInput }),
  Schema.Struct({ type: Schema.Literal("reset"), input: DeusResetConversationInput }),
  Schema.Struct({ type: Schema.Literal("launch"), input: DeusTaskLaunchInput }),
  Schema.Struct({ type: Schema.Literal("acknowledge-launch"), input: LaunchAcknowledgment }),
  Schema.Struct({ type: Schema.Literal("report"), input: TaskReport }),
  Schema.Struct({
    type: Schema.Literal("synchronize-task"),
    input: Schema.Struct({ ...DeusSessionRef.fields, inputId: DeusInputId, task: DeusTask }),
  }),
]);
export type Command = typeof Command.Type;
export const Intent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("spoken-input"), input: SpokenInput }),
  Schema.Struct({
    type: Schema.Literal("coordinate-input"),
    input: DeusInput,
    continuation: Schema.optional(Continuation),
  }),
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
    readonly observationId: DeusObservationId;
  },
  source?: DeusDelta,
):
  | { readonly changes: ReadonlyArray<DeusDurableChange>; readonly intent?: Intent }
  | DeusStateError {
  const { input } = command;
  if (
    command.type !== "respond" &&
    "conversation" in input &&
    input.conversation !== snapshot.session.conversation
  ) {
    return new DeusStateError({ reason: "conflict", message: "The conversation has changed." });
  }
  switch (command.type) {
    case "report-response": {
      if (
        !source ||
        source.change.type !== "report" ||
        source.cursor !== command.input.sourceCursor ||
        source.sessionId !== input.sessionId ||
        source.environmentId !== input.environmentId ||
        source.projectId !== input.projectId ||
        !source.change.report.conversation
      )
        return new DeusStateError({
          reason: "not-found",
          message: "Spoken report source was not found.",
        });
      const report = source.change.report;
      return {
        changes: [
          {
            type: "transcript",
            transcript: {
              id: ids.transcriptId,
              conversation: report.conversation!,
              inputId: input.inputId,
              role: "assistant",
              text: command.input.text,
              createdAt: now,
              origin: {
                ...command.input.origin,
                type: "report",
                sourceCursor: source.cursor,
                taskId: report.taskId,
                threadId: report.threadId,
                runId: report.runId,
              },
            },
          },
        ],
      };
    }
    case "respond": {
      const human = snapshot.transcripts.find(
        (entry) => entry.role === "human" && entry.inputId === command.input.humanInputId,
      );
      if (
        !human ||
        human.conversation !== command.input.conversation ||
        snapshot.transcripts.some(
          (entry) => entry.role === "assistant" && entry.inputId === human.inputId,
        )
      )
        return new DeusStateError({
          reason: "conflict",
          message: "Response must complete one original human input.",
        });
      return {
        changes: [
          {
            type: "transcript",
            transcript: {
              id: ids.transcriptId,
              conversation: human.conversation,
              inputId: human.inputId,
              role: "assistant",
              ...(human.origin ? { origin: human.origin } : {}),
              text: command.input.text,
              createdAt: now,
              ...(command.input.error
                ? { error: { code: command.input.error, recoverable: true as const } }
                : {}),
            },
          },
        ],
      };
    }
    case "observe": {
      if (
        !source ||
        source.cursor !== command.input.sourceCursor ||
        source.sessionId !== input.sessionId ||
        source.environmentId !== input.environmentId ||
        source.projectId !== input.projectId ||
        (source.change.type !== "transcript" && source.change.type !== "report")
      ) {
        return new DeusStateError({
          reason: "not-found",
          message: "Observation source was not found.",
        });
      }
      const human =
        source.change.type === "transcript" && source.change.transcript.role === "human";
      const original =
        source.change.type === "report" ? source.change.report : source.change.transcript;
      if (
        !original.conversation ||
        (command.input.kind === "correction" && !human) ||
        (command.input.supersedes !== null && command.input.kind !== "correction")
      ) {
        return new DeusStateError({
          reason: "conflict",
          message: "Only a human source can correct working context.",
        });
      }
      if (command.input.supersedes !== null) {
        const previous = snapshot.observations.find((item) => item.id === command.input.supersedes);
        if (
          !previous?.source ||
          previous.source.cursor >= source.cursor ||
          snapshot.observations.some((item) => item.supersedes === previous.id)
        ) {
          return new DeusStateError({
            reason: "conflict",
            message: "Correction target is missing or already superseded.",
          });
        }
      }
      return {
        changes: [
          {
            type: "observation",
            observation: {
              id: ids.observationId,
              kind: command.input.kind,
              source: {
                environmentId: input.environmentId,
                projectId: input.projectId,
                sessionId: input.sessionId,
                cursor: source.cursor,
              },
              conversation: original.conversation,
              text: command.input.text,
              inputId:
                source.change.type === "transcript" ? source.change.transcript.inputId : null,
              taskId: source.change.type === "report" ? source.change.report.taskId : null,
              supersedes: command.input.supersedes,
              createdAt: now,
            },
          },
        ],
      };
    }
    case "spoken-input":
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
              ...(command.type === "spoken-input" ? { origin: command.input.origin } : {}),
              text: command.input.text,
              createdAt: now,
            },
          },
        ],
        intent:
          command.type === "spoken-input"
            ? { type: "spoken-input", input: command.input }
            : { type: "coordinate-input", input: command.input },
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
              status: task.status === "pending" ? "running" : task.status,
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
    case "synchronize-task": {
      const task = snapshot.tasks.find((item) => item.id === command.input.task.id);
      if (
        !task ||
        task.inputId !== command.input.task.inputId ||
        task.conversation !== command.input.task.conversation ||
        task.workers.some(
          (worker) =>
            !command.input.task.workers.some(
              (next) =>
                next.threadId === worker.threadId &&
                (worker.runId === null || next.runId === worker.runId),
            ),
        )
      )
        return new DeusStateError({
          reason: "scope-mismatch",
          message: "Task synchronization changed its original identity.",
        });
      return { changes: [{ type: "task", task: { ...command.input.task, updatedAt: now } }] };
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
              conversation: task.conversation,
              ...(command.input.subagentId === undefined
                ? {}
                : { subagentId: command.input.subagentId }),
              mode: command.input.mode,
              text: command.input.text,
              createdAt: now,
            },
          },
          {
            type: "observation",
            observation: {
              id: ids.observationId,
              kind: "report" as const,
              source: {
                environmentId: input.environmentId,
                projectId: input.projectId,
                sessionId: input.sessionId,
                cursor: DeusCursor.make(snapshot.cursor + 1),
              },
              conversation: task.conversation,
              text: command.input.text,
              inputId: input.inputId,
              taskId: task.id,
              supersedes: null,
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
