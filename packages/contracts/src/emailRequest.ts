import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";
import { OrchestrationV2EmailDraft } from "./orchestrationV2.ts";

/** The server sends the email itself; the agent learns only that it was sent. */
export const EmailRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("send"), draft: OrchestrationV2EmailDraft }),
    Schema.Struct({ type: Schema.Literal("discard") }),
  ]),
});
export type EmailRequestAnswerInput = typeof EmailRequestAnswerInput.Type;

/** One aerc account and whether T3 Code can send from it. */
export const EmailAccountStatus = Schema.Struct({
  name: Schema.String,
  from: Schema.optionalKey(Schema.String),
  /** How it sends, e.g. "SMTP smtp.gmail.com:587 · OAuth2 token from outgoing-cred-cmd". */
  sending: Schema.optionalKey(Schema.String),
  /** Why T3 Code can't send from it. */
  problem: Schema.optionalKey(Schema.String),
});
export type EmailAccountStatus = typeof EmailAccountStatus.Type;

export const EmailAccountsReport = Schema.Struct({
  /** The accounts.conf that was read. */
  file: Schema.String,
  /** Could not read the file, e.g. "No such file". */
  fileProblem: Schema.optionalKey(Schema.String),
  accounts: Schema.Array(EmailAccountStatus),
});
export type EmailAccountsReport = typeof EmailAccountsReport.Type;

const EMAIL_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the email.",
  not_found: "This email no longer exists.",
  already_answered: "This email was already sent or discarded.",
  agent_stopped: "The agent that drafted this email has stopped.",
  no_recipients: "Add at least one recipient.",
  unknown_account: "That account is no longer in the mail client's config.",
  unsupported_account: "T3 Code can't send from this account's outgoing setting.",
  credentials_failed: "Could not get this account's credentials.",
  send_failed: "Could not send the email.",
  record_failed: "Sent the email, but could not update the card.",
} as const;

export const EmailRequestFailureReason = Schema.Literals(
  Object.keys(EMAIL_REQUEST_FAILURE_MESSAGES) as Array<keyof typeof EMAIL_REQUEST_FAILURE_MESSAGES>,
);
export type EmailRequestFailureReason = typeof EmailRequestFailureReason.Type;

export class EmailRequestError extends Schema.TaggedError<EmailRequestError>()(
  "EmailRequestError",
  {
    reason: EmailRequestFailureReason,
    /** What the mail server or credential command said, for the user to act on. */
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const base = EMAIL_REQUEST_FAILURE_MESSAGES[this.reason];
    return this.detail === undefined ? base : `${base} ${this.detail}`;
  }
}
