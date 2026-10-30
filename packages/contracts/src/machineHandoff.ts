import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const MACHINE_HANDOFF_MAX_BYTES = 8 * 1024 * 1024;
export const MachineHandoffContext = Schema.Array(
  Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String.check(Schema.isMaxLength(MACHINE_HANDOFF_MAX_BYTES)),
  }),
).check(Schema.isMaxLength(10_000));
export const MachineHandoffGitSnapshot = Schema.Struct({
  ref: Schema.String,
  head: Schema.String,
  indexTree: Schema.String,
  worktreeTree: Schema.String,
  bundle: Schema.String.check(Schema.isMaxLength(MACHINE_HANDOFF_MAX_BYTES)),
});
export type MachineHandoffGitSnapshot = typeof MachineHandoffGitSnapshot.Type;

/** Server-owned portable snapshot. Clients relay it unchanged, never interpret or edit its contents. */
export const MachineHandoffSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  modelSelection: ModelSelection,
  branch: Schema.NullOr(Schema.String),
  workspaceKind: Schema.Literals(["checkout", "worktree"]),
  context: MachineHandoffContext,
  git: MachineHandoffGitSnapshot,
});
export type MachineHandoffSnapshot = typeof MachineHandoffSnapshot.Type;
export const MachineHandoffExportInput = Schema.Struct({ threadId: ThreadId });
export type MachineHandoffExportInput = typeof MachineHandoffExportInput.Type;
export const MachineHandoffImportInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  snapshot: MachineHandoffSnapshot,
});
export type MachineHandoffImportInput = typeof MachineHandoffImportInput.Type;
export const MachineHandoffImportResult = Schema.Struct({
  threadId: ThreadId,
  sequence: Schema.optionalKey(NonNegativeInt),
  warnings: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type MachineHandoffImportResult = typeof MachineHandoffImportResult.Type;
export class MachineHandoffError extends Schema.TaggedError<MachineHandoffError>()(
  "MachineHandoffError",
  { message: Schema.String },
) {}
