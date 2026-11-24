import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";

export const SCRATCH_KEY_MAX_CHARS = 512;
const SCRATCH_MARKDOWN_MAX_CHARS = 500_000;

/**
 * A logical project key, shared across machines: `no-project:<env>`, `repo:<canonicalKey>[::<path>]`,
 * or `path:<env>:<path>`. NUL is reserved for sidebar grouping internals.
 */
export const ScratchKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SCRATCH_KEY_MAX_CHARS),
  Schema.isPattern(/^[^\u0000]+$/),
).pipe(Schema.brand("ScratchKey"));
export type ScratchKey = typeof ScratchKey.Type;

export const ScratchAttachment = Schema.Struct({
  attachmentId: ChatAttachmentId,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  width: Schema.optional(Schema.NullOr(PositiveInt)),
  height: Schema.optional(Schema.NullOr(PositiveInt)),
});
export type ScratchAttachment = typeof ScratchAttachment.Type;

export const ScratchDocumentSnapshot = Schema.Struct({
  scratchKey: ScratchKey,
  markdown: Schema.String.check(Schema.isMaxLength(SCRATCH_MARKDOWN_MAX_CHARS)),
  revision: NonNegativeInt,
  lastCursorOffset: NonNegativeInt,
  updatedAt: IsoDateTime,
  attachments: Schema.Array(ScratchAttachment),
});
export type ScratchDocumentSnapshot = typeof ScratchDocumentSnapshot.Type;

export const ScratchSummary = Schema.Struct({
  scratchKey: ScratchKey,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
  hasContent: Schema.Boolean,
});
export type ScratchSummary = typeof ScratchSummary.Type;

export const ScratchStreamEvent = Schema.Struct({
  ...ScratchDocumentSnapshot.fields,
  originClientId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ScratchStreamEvent = typeof ScratchStreamEvent.Type;

export const ScratchSummariesStreamEvent = Schema.Struct({
  summaries: Schema.Array(ScratchSummary),
});
export type ScratchSummariesStreamEvent = typeof ScratchSummariesStreamEvent.Type;

export const ScratchGetInput = Schema.Struct({
  scratchKey: ScratchKey,
});
export type ScratchGetInput = typeof ScratchGetInput.Type;

export const ScratchSubscribeInput = Schema.Struct({
  scratchKey: ScratchKey,
});
export type ScratchSubscribeInput = typeof ScratchSubscribeInput.Type;

export const ScratchSaveInput = Schema.Struct({
  scratchKey: ScratchKey,
  markdown: Schema.String.check(Schema.isMaxLength(SCRATCH_MARKDOWN_MAX_CHARS)),
  expectedRevision: NonNegativeInt,
  clientId: TrimmedNonEmptyString,
  cursorOffset: Schema.optional(NonNegativeInt),
});
export type ScratchSaveInput = typeof ScratchSaveInput.Type;

export const ScratchSaveResult = Schema.Struct({
  scratchKey: ScratchKey,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
  attachments: Schema.Array(ScratchAttachment),
});
export type ScratchSaveResult = typeof ScratchSaveResult.Type;

export const ScratchSetCursorInput = Schema.Struct({
  scratchKey: ScratchKey,
  cursorOffset: NonNegativeInt,
  clientId: TrimmedNonEmptyString,
});
export type ScratchSetCursorInput = typeof ScratchSetCursorInput.Type;

export const ScratchSetCursorResult = Schema.Struct({
  scratchKey: ScratchKey,
  lastCursorOffset: NonNegativeInt,
});
export type ScratchSetCursorResult = typeof ScratchSetCursorResult.Type;

export const ScratchConsumeChunkInput = Schema.Struct({
  scratchKey: ScratchKey,
  expectedRevision: NonNegativeInt,
  clientId: TrimmedNonEmptyString,
  nextMarkdown: Schema.String.check(Schema.isMaxLength(SCRATCH_MARKDOWN_MAX_CHARS)),
  nextCursorOffset: Schema.optional(NonNegativeInt),
  consumedAttachmentIds: Schema.Array(ChatAttachmentId),
  /** Optional idempotency key (e.g. launched messageId) so reconnect retries never double-delete. */
  consumptionId: Schema.optional(TrimmedNonEmptyString),
});
export type ScratchConsumeChunkInput = typeof ScratchConsumeChunkInput.Type;

export const ScratchConsumeChunkResult = Schema.Struct({
  scratchKey: ScratchKey,
  markdown: Schema.String.check(Schema.isMaxLength(SCRATCH_MARKDOWN_MAX_CHARS)),
  revision: NonNegativeInt,
  lastCursorOffset: NonNegativeInt,
  updatedAt: IsoDateTime,
  attachments: Schema.Array(ScratchAttachment),
});
export type ScratchConsumeChunkResult = typeof ScratchConsumeChunkResult.Type;

export const ScratchCreateImageUploadUrlInput = Schema.Struct({
  scratchKey: ScratchKey,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: PositiveInt,
  width: Schema.optional(PositiveInt),
  height: Schema.optional(PositiveInt),
});
export type ScratchCreateImageUploadUrlInput = typeof ScratchCreateImageUploadUrlInput.Type;

export const ScratchCreateImageUploadUrlResult = Schema.Struct({
  attachmentId: ChatAttachmentId,
  relativeUrl: TrimmedNonEmptyString,
  expiresAt: PositiveInt,
});
export type ScratchCreateImageUploadUrlResult = typeof ScratchCreateImageUploadUrlResult.Type;

export class ScratchRevisionConflictError extends Schema.TaggedError<ScratchRevisionConflictError>()(
  "ScratchRevisionConflictError",
  {
    scratchKey: ScratchKey,
    expectedRevision: NonNegativeInt,
    current: ScratchDocumentSnapshot,
  },
) {}

export class ScratchValidationError extends Schema.TaggedError<ScratchValidationError>()(
  "ScratchValidationError",
  {
    message: Schema.String,
  },
) {}

export class ScratchStorageError extends Schema.TaggedError<ScratchStorageError>()(
  "ScratchStorageError",
  {
    message: Schema.String,
  },
) {}
