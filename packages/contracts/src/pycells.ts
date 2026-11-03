import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PycellsNotebookOutput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    mimeType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: Schema.String.check(
      Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("error"), text: Schema.String }),
]);
export type PycellsNotebookOutput = typeof PycellsNotebookOutput.Type;

export const PycellsNotebookCell = Schema.Struct({
  id: TrimmedNonEmptyString,
  index: PositiveInt,
  cellType: Schema.Literals(["code", "markdown", "raw"]),
  source: Schema.String,
  executionCount: Schema.NullOr(NonNegativeInt),
  outputs: Schema.Array(PycellsNotebookOutput),
});
export type PycellsNotebookCell = typeof PycellsNotebookCell.Type;

export const PycellsNotebookKernel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  notebookPath: Schema.String,
  running: Schema.Boolean,
  cells: Schema.Array(PycellsNotebookCell),
});
export type PycellsNotebookKernel = typeof PycellsNotebookKernel.Type;

export const PycellsNotebookSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  kernels: Schema.Array(PycellsNotebookKernel),
});
export type PycellsNotebookSnapshot = typeof PycellsNotebookSnapshot.Type;

export const PycellsNotebookInput = Schema.Struct({ threadId: ThreadId });
export type PycellsNotebookInput = typeof PycellsNotebookInput.Type;

export class PycellsNotebookError extends Schema.TaggedError<PycellsNotebookError>()(
  "PycellsNotebookError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "unknownThread",
      "unavailable",
      "invalidResponse",
      "hostError",
      "tooLarge",
      "timeout",
    ]),
  },
) {
  override get message(): string {
    return `Thread notebook could not be read (${this.reason}).`;
  }
}
