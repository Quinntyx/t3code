import {
  CommandId,
  DeusHumanTaskActionInput,
  DeusInputReceipt,
  DeusTask,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const TaskActionPlan = Schema.Struct({
  type: Schema.Literal("task-action"),
  input: DeusHumanTaskActionInput,
  task: DeusTask,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  commandId: CommandId,
  model: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreePath: Schema.NullOr(Schema.String),
  dispatchMode: Schema.Union([
    Schema.Struct({ type: Schema.Literals(["start_immediately", "queue_after_active"]) }),
    Schema.Struct({ type: Schema.Literal("steer_active"), targetRunId: RunId }),
  ]),
  text: Schema.NullOr(Schema.String),
  query: Schema.NullOr(Schema.String),
});
export type TaskActionPlan = typeof TaskActionPlan.Type;
export const TaskActionRecord = Schema.Struct({
  receipt: DeusInputReceipt,
  plan: TaskActionPlan,
  result: Schema.NullOr(Schema.Struct({ task: DeusTask, answer: Schema.NullOr(Schema.String) })),
});
export type TaskActionRecord = typeof TaskActionRecord.Type;
