// An agent drafts an email into a card; the user edits it and the server sends it. The agent never
// holds mail credentials. Drafting does not wait (provider CLIs abandon a long tool call): the
// answer reaches the agent as a notification.
import {
  CommandId,
  EmailRequestError,
  MessageId,
  OrchestratorMcpFailure,
  TurnItemId,
  type EmailRequestAnswerInput,
  type OrchestrationV2EmailDraft,
  type OrchestrationV2EmailEditedField,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpComposeEmailInput,
  type OrchestratorMcpComposeEmailResult,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { findAercAccount } from "./aercAccounts.ts";
import * as Mailer from "./Mailer.ts";
import * as MailInbox from "./MailInbox.ts";

type EmailRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "email_request" }>;

/** The notification that tells the agent how its draft ended. */
type EmailRequestWake = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
};

const EDITABLE_FIELDS = [
  ["from", "account"],
  ["to", "to"],
  ["cc", "cc"],
  ["bcc", "bcc"],
  ["subject", "subject"],
  ["body", "body"],
] as const;

export class EmailRequests extends Context.Service<
  EmailRequests,
  {
    /**
     * Shows the draft in the calling thread and returns at once. A retry with
     * the same clientRequestId and MCP credential returns the card's current
     * outcome.
     */
    readonly draft: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly requestNamespace: string;
      readonly request: OrchestratorMcpComposeEmailInput;
    }) => Effect.Effect<OrchestratorMcpComposeEmailResult, OrchestratorMcpFailure>;
    readonly answer: (input: EmailRequestAnswerInput) => Effect.Effect<void, EmailRequestError>;
  }
>()("t3/email/EmailRequests") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

/**
 * Turn item ids are global; scope the key to this thread and provider session,
 * since a later session may reuse it.
 */
const cardId = (threadId: ThreadId, requestNamespace: string, key: string) =>
  TurnItemId.make(
    `turn-item:email-request:${encodeURIComponent(threadId)}:${encodeURIComponent(requestNamespace)}:${encodeURIComponent(key)}`,
  );

const pendingResult = (turnItemId: TurnItemId): OrchestratorMcpComposeEmailResult => ({
  status: "pending",
  turnItemId,
});

const resultOf = (card: EmailRequestItem): OrchestratorMcpComposeEmailResult => {
  switch (card.emailStatus) {
    case "pending":
      return pendingResult(card.id);
    case "sent":
      return {
        status: "sent",
        message: "Email sent.",
        from: findAercAccount(card.accounts, card.draft.account)?.from ?? card.draft.account,
        to: card.draft.to,
        cc: card.draft.cc,
        bcc: card.draft.bcc,
        subject: card.draft.subject,
        edited: card.edited ?? [],
      };
    case "discarded":
    case "cancelled":
      return { status: card.emailStatus };
  }
};

const draftSubject = (draft: OrchestrationV2EmailDraft) => draft.subject.trim() || "(no subject)";

/**
 * The notification an answer sends the agent: what the user sent or discarded,
 * never mail credentials or the edited body.
 */
const outcomeNotice = (
  outcome:
    | {
        readonly status: "sent";
        readonly from: string;
        readonly draft: OrchestrationV2EmailDraft;
        readonly edited: ReadonlyArray<OrchestrationV2EmailEditedField>;
      }
    | { readonly status: "discarded"; readonly draft: OrchestrationV2EmailDraft },
): Omit<EmailRequestWake, "messageId"> => {
  const subject = draftSubject(outcome.draft);
  if (outcome.status === "discarded") {
    return {
      text: `The user discarded the email draft "${subject}". Do not draft or send it again unless the user asks.`,
      notification: {
        source: { kind: "background_task" },
        outcome: "cancelled",
        summary: `Discarded “${subject}”`,
      },
    };
  }
  const parts = [
    `The user sent the email "${subject}" from ${outcome.from}${
      outcome.draft.to.length > 0 ? ` to ${outcome.draft.to.join(", ")}` : ""
    }.`,
    ...(outcome.draft.cc.length > 0 ? [`Cc: ${outcome.draft.cc.join(", ")}.`] : []),
    ...(outcome.draft.bcc.length > 0 ? [`Bcc: ${outcome.draft.bcc.join(", ")}.`] : []),
    ...(outcome.edited.length > 0
      ? [`Edited fields before sending: ${outcome.edited.join(", ")}.`]
      : []),
  ];
  return {
    text: parts.join(" "),
    notification: {
      source: { kind: "background_task" },
      outcome: "completed",
      summary: `Sent “${subject}”`,
    },
  };
};

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const mailer = yield* Mailer.Mailer;
  const random = yield* SecureRandom.SecureRandom;
  const inbox = yield* Effect.serviceOption(MailInbox.MailInbox);
  // One send or discard per card at a time; the next one rereads the card after it.
  const sending = new Map<string, Deferred.Deferred<void>>();
  const exclusive = Effect.fn("EmailRequests.exclusive")(function* <A, E>(
    turnItemId: string,
    effect: Effect.Effect<A, E>,
  ) {
    let earlier = sending.get(turnItemId);
    while (earlier !== undefined) {
      yield* Deferred.await(earlier);
      earlier = sending.get(turnItemId);
    }
    const done = yield* Deferred.make<void>();
    sending.set(turnItemId, done);
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          sending.delete(turnItemId);
          return Deferred.succeed(done, undefined);
        }),
      ),
    );
  });

  const loadCard = (threadId: ThreadId, turnItemId: string) =>
    threadManagement
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["email_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          // A deleted thread's cards went with it.
          return item?.type === "email_request" && records.thread.deletedAt === null
            ? item
            : undefined;
        }),
      );

  const draft: EmailRequests["Service"]["draft"] = Effect.fn("EmailRequests.draft")(function* ({
    threadId,
    providerInstanceId,
    requestNamespace,
    request,
  }) {
    const accounts = yield* mailer.accounts;
    if (accounts.length === 0) {
      return yield* failure(
        "orchestration_error",
        "No mail account can send from this machine. T3 Code sends with the accounts in aerc's accounts.conf.",
      );
    }
    const key = request.clientRequestId ?? (yield* random.uuidV4());
    const turnItemId = cardId(threadId, requestNamespace, key);
    // A retry with the same clientRequestId finds this card and records nothing.
    if (request.clientRequestId !== undefined) {
      const existing = yield* loadCard(threadId, turnItemId).pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not read the email: ${errorMessage(error)}`),
        ),
      );
      if (existing !== undefined) return resultOf(existing);
    }
    const reply =
      request.replyTo === undefined
        ? undefined
        : yield* Option.match(inbox, {
            onNone: () =>
              Effect.fail(
                failure(
                  "capability_denied",
                  "Native inbox access is unavailable; do not use direct mail commands.",
                ),
              ),
            onSome: (service) =>
              service
                .replyContext(request.replyTo!)
                .pipe(Effect.mapError((error) => failure("orchestration_error", error.message))),
          });
    const sender = request.from ?? reply?.account;
    const account = sender === undefined ? accounts[0] : findAercAccount(accounts, sender);
    if (account === undefined) {
      return yield* failure(
        "invalid_request",
        `No account matches from "${sender}". Accounts: ${accounts
          .map((candidate) => `${candidate.name} (${candidate.from})`)
          .join(", ")}.`,
      );
    }
    const projection = yield* threadManagement
      .getThreadRecords(threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not read the thread: ${errorMessage(error)}`),
        ),
      );
    const run = ThreadManagementService.latestActiveRun(projection);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== providerInstanceId
    ) {
      return yield* failure(
        "parent_not_active",
        "Drafting an email requires an active run owned by this MCP provider session.",
      );
    }
    const runId = run.id;
    const nodeId = run.rootNodeId;
    const header = (name: string) =>
      reply?.headers[name] ??
      Object.entries(reply?.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
    const replyAddress = header("reply-to") || header("from");
    const originalId =
      header("message-id")?.match(/<[^<>\s]+>/)?.[0] ??
      (reply !== undefined && /^[^<>\s"]+$/.test(reply.messageId)
        ? `<${reply.messageId}>`
        : undefined);
    const references =
      originalId === undefined
        ? undefined
        : [
            ...new Set([
              ...(header("references")?.match(/<[^<>\s]+>/g) ?? []).slice(-20),
              originalId,
            ]),
          ];
    const initial: OrchestrationV2EmailDraft = {
      account: account.name,
      to: request.to.length === 0 && replyAddress ? [replyAddress] : request.to,
      cc: request.cc ?? [],
      bcc: request.bcc ?? [],
      subject:
        request.subject ||
        (reply === undefined ? "" : `Re: ${header("subject") ?? ""}`.replace(/^Re: Re:/i, "Re:")),
      body: request.body,
      ...(originalId === undefined ? {} : { inReplyTo: originalId, references }),
    };
    yield* threadManagement
      .dispatch({
        type: "email_request.record",
        commandId: CommandId.make(
          `command:mcp:${encodeURIComponent(requestNamespace)}:email-pending:${encodeURIComponent(key)}`,
        ),
        threadId,
        runId,
        nodeId,
        turnItemId,
        accounts,
        draft: initial,
        emailStatus: "pending",
      })
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not record the email: ${errorMessage(error)}`),
        ),
      );
    yield* Effect.annotateCurrentSpan({ "email_request.status": "pending" });
    return pendingResult(turnItemId);
  });

  const answer: EmailRequests["Service"]["answer"] = Effect.fn("EmailRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "email_request.answer": input.answer.type,
      });
      return yield* exclusive(input.turnItemId, answerOnce(input));
    },
  );

  const answerOnce = Effect.fn("EmailRequests.answerOnce")(function* (
    input: EmailRequestAnswerInput,
  ) {
    const item = yield* loadCard(input.threadId, input.turnItemId).pipe(
      Effect.mapError((cause) => new EmailRequestError({ reason: "load_failed", cause })),
    );
    if (item === undefined || item.runId === null || item.nodeId === null) {
      return yield* new EmailRequestError({ reason: "not_found" });
    }
    // Any time while the card is open: the agent hears the answer as a
    // notification, whether or not its run is still going.
    if (item.emailStatus !== "pending") {
      return yield* new EmailRequestError({ reason: "already_answered" });
    }
    const runId = item.runId;
    const nodeId = item.nodeId;
    const record = (
      emailStatus: "sent" | "discarded",
      sent: OrchestrationV2EmailDraft,
      wake: EmailRequestWake,
      edited?: ReadonlyArray<OrchestrationV2EmailEditedField>,
    ) =>
      threadManagement
        .dispatch({
          type: "email_request.record",
          commandId: CommandId.make(`email-request:${item.id}:${emailStatus}`),
          threadId: input.threadId,
          runId,
          nodeId,
          turnItemId: item.id,
          accounts: item.accounts,
          draft: sent,
          emailStatus,
          ...(edited === undefined ? {} : { edited }),
          wake,
        })
        .pipe(
          Effect.mapError((cause) => new EmailRequestError({ reason: "record_failed", cause })),
        );
    if (input.answer.type === "discard") {
      return yield* record("discarded", item.draft, {
        messageId: MessageId.make(`message:email-request:${item.id}`),
        ...outcomeNotice({ status: "discarded", draft: item.draft }),
      });
    }
    const { account, to, cc, bcc, subject, body } = input.answer.draft;
    const sent: OrchestrationV2EmailDraft = {
      account,
      to,
      cc,
      bcc,
      subject,
      body,
      ...(item.draft.inReplyTo === undefined ? {} : { inReplyTo: item.draft.inReplyTo }),
      ...(item.draft.references === undefined ? {} : { references: item.draft.references }),
    };
    if (sent.to.length + sent.cc.length + sent.bcc.length === 0) {
      return yield* new EmailRequestError({ reason: "no_recipients" });
    }
    if (findAercAccount(item.accounts, sent.account) === undefined) {
      return yield* new EmailRequestError({ reason: "unknown_account" });
    }
    yield* mailer.send(sent);
    const from = findAercAccount(item.accounts, sent.account)?.from ?? sent.account;
    const edited = EDITABLE_FIELDS.filter(
      ([, field]) => JSON.stringify(item.draft[field]) !== JSON.stringify(sent[field]),
    ).map(([name]) => name);
    // The mail has left, so the card must say so; a retry here never sends twice.
    yield* record(
      "sent",
      sent,
      {
        messageId: MessageId.make(`message:email-request:${item.id}`),
        ...outcomeNotice({ status: "sent", from, draft: sent, edited }),
      },
      edited,
    ).pipe(Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 4 }));
  });

  return EmailRequests.of({ draft, answer });
});

export const layer = Layer.effect(EmailRequests, make);
