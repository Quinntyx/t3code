import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const MailIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(998),
  Schema.isPattern(/^[^\x00-\x1f\x7f]+$/),
);
const MailTag = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\x00-\x20\x7f+-][^\x00-\x20\x7f]*$/),
);
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const EmailInboxAccountConfig = Schema.Struct({
  name: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString,
});
export type EmailInboxAccountConfig = typeof EmailInboxAccountConfig.Type;

export const EmailMessageRef = Schema.Struct({
  account: TrimmedNonEmptyString,
  messageId: MailIdentifier.annotate({
    description: "Exact raw message ID returned by email_search.",
  }),
});
export type EmailMessageRef = typeof EmailMessageRef.Type;

export const EmailSearchInput = Schema.Struct({
  account: TrimmedNonEmptyString,
  query: Schema.String.check(Schema.isMaxLength(4096)).annotate({
    description:
      "Notmuch search terms, scoped to this account. Use * for all non-excluded mail; read and unread are included.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  offset: Schema.optional(Offset),
});
export type EmailSearchInput = typeof EmailSearchInput.Type;

export const EmailMessageSummary = Schema.Struct({
  ...EmailMessageRef.fields,
  headers: Schema.Record(Schema.String, Schema.String),
  headersTruncated: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  timestamp: Schema.Number,
});
export type EmailMessageSummary = typeof EmailMessageSummary.Type;

export const EmailSearchResult = Schema.Struct({
  messages: Schema.Array(EmailMessageSummary),
  total: Schema.Number,
  nextOffset: Schema.NullOr(Offset),
  freshness: Schema.Literal("existing_index_remote_unverified"),
});

export const EmailReadInput = Schema.Struct({
  ...EmailMessageRef.fields,
  partsOffset: Schema.optional(Offset).annotate({
    description: "Offset for continuing MIME part metadata.",
  }),
  part: Schema.optional(Offset).annotate({
    description: "Text MIME part ID from parts. Default: first text part.",
  }),
  offset: Schema.optional(Offset).annotate({
    description: "Character offset for continuing this text part.",
  }),
});
export type EmailReadInput = typeof EmailReadInput.Type;

export const EmailPart = Schema.Struct({
  id: Schema.Number,
  contentType: Schema.String,
  filename: Schema.optional(Schema.String),
  text: Schema.Boolean,
});
export const EmailReadResult = Schema.Struct({
  ...EmailMessageSummary.fields,
  parts: Schema.Array(EmailPart),
  nextPartsOffset: Schema.NullOr(Offset),
  part: Schema.NullOr(Schema.Number),
  text: Schema.String,
  totalCharacters: Schema.Number,
  contentWarning: Schema.optional(Schema.String),
  nextOffset: Schema.NullOr(Offset),
  untrusted: Schema.Literal(true),
});
export type EmailReadResult = typeof EmailReadResult.Type;

export const EmailTagInput = Schema.Struct({
  account: TrimmedNonEmptyString,
  messageIds: Schema.Array(MailIdentifier).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  add: Schema.Array(MailTag).check(Schema.isMaxLength(30)),
  remove: Schema.Array(MailTag).check(Schema.isMaxLength(30)),
});
export type EmailTagInput = typeof EmailTagInput.Type;
export const EmailTagResult = Schema.Struct({
  outcomes: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      status: Schema.Literals(["updated", "unchanged", "failed"]),
      tags: Schema.Array(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
  remoteAcknowledged: Schema.Literal(false),
});
export type EmailTagResult = typeof EmailTagResult.Type;

export const EmailAttachmentInput = Schema.Struct({
  ...EmailMessageRef.fields,
  part: Schema.Int.check(Schema.isGreaterThan(0)),
  offset: Schema.optional(Offset).annotate({
    description: "Byte offset for continuing this attachment.",
  }),
});
export type EmailAttachmentInput = typeof EmailAttachmentInput.Type;
export const EmailAttachmentResult = Schema.Struct({
  contentType: Schema.String,
  filename: Schema.optional(Schema.String),
  base64: Schema.String,
  totalBytes: Schema.Number,
  nextOffset: Schema.NullOr(Offset),
  untrusted: Schema.Literal(true),
});

export const EmailInboxAccountsResult = Schema.Struct({
  accounts: Schema.Array(Schema.Struct({ name: Schema.String })),
  taggingEnabled: Schema.Boolean,
  refreshAvailable: Schema.Boolean,
});
export const EmailRefreshResult = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "unavailable"]),
  remoteAcknowledged: Schema.Literal(false),
});

export class EmailInboxError extends Schema.TaggedError<EmailInboxError>()("EmailInboxError", {
  reason: Schema.Literals([
    "disabled",
    "tagging_disabled",
    "unknown_account",
    "not_found",
    "invalid_request",
    "backend_unavailable",
    "backend_failed",
    "invalid_backend_data",
    "output_limit",
    "timeout",
    "flag_sync_disabled",
    "unknown_part",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const messages = {
      disabled:
        "Inbox access is off. Enable it in Settings → Email. Do not fall back to direct mail commands.",
      tagging_disabled: "Email tagging is off. Enable it in Settings → Email.",
      unknown_account: "This inbox account is not configured in Settings → Email.",
      not_found:
        "This message is unavailable in the selected account or excluded from inbox access.",
      invalid_request: "The email request is invalid.",
      backend_unavailable: "The configured inbox backend is unavailable on this environment.",
      backend_failed: "The inbox backend operation failed.",
      invalid_backend_data: "The inbox backend returned invalid data.",
      output_limit: "This mail part exceeds the backend output limit.",
      timeout: "The inbox backend operation timed out. Its outcome may need to be checked.",
      flag_sync_disabled:
        "Maildir flag synchronization must be enabled before changing mapped mail flags.",
      unknown_part: "This MIME part is unavailable for the requested operation.",
    };
    return messages[this.reason];
  }
}
