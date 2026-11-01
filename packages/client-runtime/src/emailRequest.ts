import type {
  EmailRequestAnswerInput,
  OrchestrationV2EmailDraft,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

export type EmailRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "email_request" }>;

export const EMAIL_REQUEST_NO_PERMISSION_NOTE =
  "Only a session that can run agents here can send this.";
export const EMAIL_REQUEST_PRIVACY_NOTE =
  "Sends from your own mail account, only when you press Send.";

/** The editable fields, with address lists as the text the user types. */
export interface EmailComposerFields {
  readonly account: string;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * Splits a typed address list on commas, semicolons and new lines, keeping
 * commas inside a quoted name such as `"Lovelace, Ada" <ada@example.com>`.
 */
export function parseAddressList(text: string): ReadonlyArray<string> {
  const addresses: Array<string> = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const character of text) {
    if (character === '"') quoted = !quoted;
    else if (character === "<") angled = true;
    else if (character === ">") angled = false;
    if (!quoted && !angled && (character === "," || character === ";" || character === "\n")) {
      addresses.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  addresses.push(current);
  return addresses.map((address) => address.trim()).filter((address) => address !== "");
}

const formatAddressList = (addresses: ReadonlyArray<string>) => addresses.join(", ");

// The timeline unmounts rows scrolled out of view; keep edits until the card is answered.
const editedFields = new Map<string, EmailComposerFields>();

export const emailComposerEdits = {
  get: (item: Pick<EmailRequestItem, "id" | "draft">) =>
    editedFields.get(item.id) ?? emailComposerFields(item.draft),
  set: (item: Pick<EmailRequestItem, "id">, fields: EmailComposerFields) =>
    void editedFields.set(item.id, fields),
  clear: (item: Pick<EmailRequestItem, "id">) => void editedFields.delete(item.id),
};

function emailComposerFields(draft: OrchestrationV2EmailDraft): EmailComposerFields {
  return {
    account: draft.account,
    to: formatAddressList(draft.to),
    cc: formatAddressList(draft.cc),
    bcc: formatAddressList(draft.bcc),
    subject: draft.subject,
    body: draft.body,
  };
}

function emailDraftFromFields(fields: EmailComposerFields): OrchestrationV2EmailDraft {
  return {
    account: fields.account,
    to: parseAddressList(fields.to),
    cc: parseAddressList(fields.cc),
    bcc: parseAddressList(fields.bcc),
    subject: fields.subject.trim(),
    body: fields.body,
  };
}

const hasRecipients = (draft: OrchestrationV2EmailDraft) =>
  draft.to.length + draft.cc.length + draft.bcc.length > 0;

export type EmailRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "sent" | "discarded" | "ended";
      readonly label: string;
    };

const recipientSummary = (draft: OrchestrationV2EmailDraft) => {
  const [first, ...rest] = [...draft.to, ...draft.cc, ...draft.bcc];
  if (first === undefined) return "no one";
  const name = (/^\s*"?([^"<]+?)"?\s*</.exec(first)?.[1] ?? first).trim();
  return rest.length === 0 ? name : `${name} and ${rest.length} more`;
};

/**
 * `visibility` is the projected row's: a draft inherited from another
 * thread (a fork) can only be sent where it was drafted.
 */
export function emailRequestDisplay(
  item: Pick<EmailRequestItem, "emailStatus" | "draft">,
  visibility: "local" | "inherited" | "synthetic",
): EmailRequestDisplay {
  const subject = item.draft.subject.trim() || "(no subject)";
  switch (item.emailStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: `${subject} · Waiting in the original thread` };
    case "sent":
      return {
        kind: "answered",
        outcome: "sent",
        label: `Sent “${subject}” to ${recipientSummary(item.draft)}`,
      };
    case "discarded":
      return { kind: "answered", outcome: "discarded", label: `Discarded “${subject}”` };
    case "cancelled":
      return { kind: "answered", outcome: "ended", label: `“${subject}” · Draft ended` };
  }
}

export function emailRequestAnswerInput(
  item: Pick<EmailRequestItem, "id" | "threadId">,
  answer:
    | { readonly type: "send"; readonly fields: EmailComposerFields }
    | { readonly type: "discard" },
): EmailRequestAnswerInput | null {
  if (answer.type === "discard") {
    return { threadId: item.threadId, turnItemId: item.id, answer: { type: "discard" } };
  }
  const draft = emailDraftFromFields(answer.fields);
  if (!hasRecipients(draft)) return null;
  return { threadId: item.threadId, turnItemId: item.id, answer: { type: "send", draft } };
}

const USER_FACING_FAILURE_TAGS = new Set(["EmailRequestError", "EnvironmentAuthorizationError"]);

/** Only known server errors pass their message through; anything else gets the generic copy. */
export function emailRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not send the email. Try again.";
}
