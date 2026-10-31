// An agent drafts an email into a card; the user edits it and the server sends it. The agent never
// holds mail credentials and learns only how the card ended and what was sent.
import {
  CommandId,
  EmailRequestError,
  OrchestratorMcpFailure,
  TurnItemId,
  type EmailRequestAnswerInput,
  type OrchestrationV2EmailDraft,
  type OrchestratorMcpSendEmailInput,
  type OrchestratorMcpSendEmailResult,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { findAercAccount } from "./aercAccounts.ts";
import * as Mailer from "./Mailer.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const POLL_INTERVAL = Duration.millis(500);

export class EmailRequests extends Context.Service<
  EmailRequests,
  {
    /** Shows the draft in the calling thread and waits for the user to send or discard it. */
    readonly draft: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly requestNamespace: string;
      readonly request: OrchestratorMcpSendEmailInput;
    }) => Effect.Effect<OrchestratorMcpSendEmailResult, OrchestratorMcpFailure>;
    readonly answer: (input: EmailRequestAnswerInput) => Effect.Effect<void, EmailRequestError>;
  }
>()("t3/email/EmailRequests") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const mailer = yield* Mailer.Mailer;
  const crypto = yield* Crypto.Crypto;
  // One send or close per card at a time; the next one rereads the card after it.
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
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["email_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          return {
            item: item?.type === "email_request" ? item : undefined,
            runs: records.runs,
          };
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
    const account =
      request.from === undefined ? accounts[0] : findAercAccount(accounts, request.from);
    if (account === undefined) {
      return yield* failure(
        "invalid_request",
        `No account matches from "${request.from}". Accounts: ${accounts
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
    const key = request.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const turnItemId = TurnItemId.make(
      `turn-item:email-request:${encodeURIComponent(threadId)}:${encodeURIComponent(key)}`,
    );
    const initial: OrchestrationV2EmailDraft = {
      account: account.name,
      to: request.to,
      cc: request.cc ?? [],
      bcc: request.bcc ?? [],
      subject: request.subject,
      body: request.body,
    };
    const record = (emailStatus: "pending" | "cancelled") =>
      threadManagement
        .dispatch({
          type: "email_request.record",
          commandId: CommandId.make(
            `command:mcp:${encodeURIComponent(requestNamespace)}:email-${emailStatus}:${encodeURIComponent(key)}`,
          ),
          threadId,
          runId,
          nodeId,
          turnItemId,
          accounts,
          draft: initial,
          emailStatus,
        })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not record the email: ${errorMessage(error)}`),
          ),
        );
    yield* record("pending");
    // Only this call reports the result, so the card closes with it.
    const closeCard = record("cancelled").pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not close an email card", { error: error.message }),
      ),
    );

    const answered = yield* Effect.gen(function* () {
      while (true) {
        const card = yield* loadCard(threadId, turnItemId).pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not read the email: ${errorMessage(error)}`),
          ),
        );
        if (card.item !== undefined && card.item.emailStatus !== "pending") return card.item;
        const current = card.runs.find((candidate) => candidate.id === runId);
        if (current === undefined || ThreadManagementService.isTerminalRunStatus(current.status)) {
          yield* closeCard;
          return undefined;
        }
        yield* Effect.sleep(POLL_INTERVAL);
      }
    }).pipe(
      Effect.timeoutOption(
        Duration.millis(
          Math.min(request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
        ),
      ),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
    );
    const timedOut = Option.isNone(answered);
    const item = timedOut
      ? // Closing waits for a send the user already started, and no send starts while it closes.
        yield* exclusive(
          turnItemId,
          closeCard.pipe(
            Effect.andThen(loadCard(threadId, turnItemId)),
            Effect.map((card) => card.item),
            Effect.orElseSucceed(() => undefined),
          ),
        )
      : answered.value;
    if (item?.emailStatus !== "sent") {
      const status =
        item?.emailStatus === "discarded" ? "discarded" : timedOut ? "timed_out" : "cancelled";
      yield* Effect.annotateCurrentSpan({ "email_request.status": status });
      return { status };
    }
    yield* Effect.annotateCurrentSpan({ "email_request.status": "sent" });
    const from = findAercAccount(item.accounts, item.draft.account)?.from ?? item.draft.account;
    return {
      status: "sent",
      message: "Email sent.",
      from,
      to: item.draft.to,
      subject: item.draft.subject,
    };
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
    const { item, runs } = yield* loadCard(input.threadId, input.turnItemId).pipe(
      Effect.mapError((cause) => new EmailRequestError({ reason: "load_failed", cause })),
    );
    if (item === undefined || item.runId === null || item.nodeId === null) {
      return yield* new EmailRequestError({ reason: "not_found" });
    }
    if (item.emailStatus !== "pending") {
      return yield* new EmailRequestError({ reason: "already_answered" });
    }
    const run = runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new EmailRequestError({ reason: "agent_stopped" });
    }
    const runId = item.runId;
    const nodeId = item.nodeId;
    const record = (emailStatus: "sent" | "discarded", sent: OrchestrationV2EmailDraft) =>
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
        })
        .pipe(
          Effect.mapError((cause) => new EmailRequestError({ reason: "record_failed", cause })),
        );
    if (input.answer.type === "discard") {
      return yield* record("discarded", item.draft);
    }
    const sent = input.answer.draft;
    if (sent.to.length + sent.cc.length + sent.bcc.length === 0) {
      return yield* new EmailRequestError({ reason: "no_recipients" });
    }
    if (findAercAccount(item.accounts, sent.account) === undefined) {
      return yield* new EmailRequestError({ reason: "unknown_account" });
    }
    yield* mailer.send(sent);
    // The mail has left, so the card must say so; a retry here never sends twice.
    yield* record("sent", sent).pipe(
      Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 4 }),
    );
  });

  return EmailRequests.of({ draft, answer });
});

export const layer = Layer.effect(EmailRequests, make);
