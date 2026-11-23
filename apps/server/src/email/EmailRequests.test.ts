import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EmailRequestError,
  type OrchestrationV2EmailDraft,
  type OrchestrationV2EmailEditedField,
  type OrchestrationV2EmailRequestStatus,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { emailRecordReplaces } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as EmailRequests from "./EmailRequests.ts";
import * as Mailer from "./Mailer.ts";
import * as MailInbox from "./MailInbox.ts";

const threadId = ThreadId.make("thread-email");
const turnItemId = TurnItemId.make("turn-item:email-request:1");
const accounts = [
  { name: "school", from: "Ada <ada@school.edu>" },
  { name: "gmail", from: "Ada <ada@gmail.com>" },
];
const drafted: OrchestrationV2EmailDraft = {
  account: "school",
  to: ["prof@school.edu"],
  cc: [],
  bcc: [],
  subject: "Office hours",
  body: "Can we meet Tuesday?",
};

const withService = <A, E>(
  body: (input: {
    readonly service: EmailRequests.EmailRequests["Service"];
    readonly sent: Array<OrchestrationV2EmailDraft>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly runStatus?: string;
    readonly sendFails?: boolean;
    /** Holds a send until it opens, and signals once a send is waiting on it. */
    readonly sendGate?: {
      readonly started: Deferred.Deferred<void>;
      readonly open: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const sent: Array<OrchestrationV2EmailDraft> = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let emailStatus: OrchestrationV2EmailRequestStatus = "pending";
    let cardId: string = turnItemId;
    let cardDraft = drafted;
    let cardEdited: ReadonlyArray<OrchestrationV2EmailEditedField> | undefined = undefined;
    let recorded = false;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(MailInbox.MailInbox)({
        replyContext: () =>
          Effect.succeed({
            account: "gmail",
            messageId: "original@example.invalid",
            timestamp: 1,
            tags: ["unread"],
            headersTruncated: false,
            headers: {
              From: "Ada <ada@example.invalid>",
              "reply-to": "reply@example.invalid",
              references: "<earlier@example.invalid>",
              "message-id": "<original@example.invalid>",
            },
          }),
      }),
      Layer.succeed(
        Mailer.Mailer,
        Mailer.Mailer.of({
          accounts: Effect.succeed(accounts),
          report: Effect.succeed({ file: "accounts.conf", accounts: [] }),
          send: (draft) =>
            Effect.gen(function* () {
              if (options.sendGate !== undefined) {
                yield* Deferred.succeed(options.sendGate.started, undefined);
                yield* Deferred.await(options.sendGate.open);
              }
              if (options.sendFails) {
                return yield* new EmailRequestError({
                  reason: "send_failed",
                  detail: "535 Authentication failed",
                });
              }
              sent.push(draft);
            }),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        // Reads, then yields, so concurrent answers can both see the card pending.
        getThreadRecords: () =>
          Effect.sync(
            () =>
              ({
                thread: { id: threadId, deletedAt: null },
                runs: [
                  {
                    id: "run-1",
                    status: options.runStatus ?? "running",
                    ordinal: 1,
                    rootNodeId: "node-root",
                    providerInstanceId: "claudeAgent",
                  },
                ],
                turnItems: [
                  {
                    id: cardId,
                    threadId,
                    runId: "run-1",
                    nodeId: "node-root",
                    type: "email_request",
                    accounts,
                    draft: cardDraft,
                    emailStatus,
                    ...(cardEdited === undefined ? {} : { edited: cardEdited }),
                  },
                ],
              }) as never,
          ).pipe(Effect.tap(() => Effect.yieldNow)),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (command.type !== "email_request.record") return {} as never;
            cardId = command.turnItemId;
            if (!recorded || emailRecordReplaces(emailStatus, command.emailStatus)) {
              recorded = true;
              emailStatus = command.emailStatus;
              cardDraft = command.draft;
              cardEdited = command.edited;
            }
            return {} as never;
          }),
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* EmailRequests.EmailRequests;
      return yield* body({ service, sent, dispatched });
    }).pipe(Effect.provide(EmailRequests.layer.pipe(Layer.provide(layerDependencies))));
  });

it.effect("sends the user's edited email, records edits, and wakes the agent", () =>
  withService(({ service, sent, dispatched }) =>
    Effect.gen(function* () {
      const edited = {
        ...drafted,
        account: "gmail",
        subject: "Office hours (Tue)",
      };
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "send", draft: edited },
      });
      assert.deepEqual(sent, [edited]);
      assert.equal(dispatched.length, 1);
      const record = dispatched[0] as Extract<
        OrchestrationV2ServerCommand,
        { type: "email_request.record" }
      >;
      assert.equal(record.type, "email_request.record");
      assert.equal(record.emailStatus, "sent");
      assert.deepEqual(record.draft, edited);
      assert.deepEqual(record.edited, ["from", "subject"]);
      assert.include(record.wake?.text ?? "", "Ada <ada@gmail.com>");
      assert.include(record.wake?.text ?? "", "Edited fields before sending: from, subject.");
      assert.equal(record.wake?.notification.outcome, "completed");
    }),
  ),
);

it.effect("a double click sends once", () =>
  withService(({ service, sent }) =>
    Effect.gen(function* () {
      const answer = service.answer({
        threadId,
        turnItemId,
        answer: { type: "send", draft: drafted },
      });
      const results = yield* Effect.all([Effect.result(answer), Effect.result(answer)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
      assert.equal(sent.length, 1);
    }),
  ),
);

it.effect("discarding sends nothing, wakes the agent, and answers the card once", () =>
  withService(({ service, sent, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "discard" },
      });
      const record = dispatched[0] as Extract<
        OrchestrationV2ServerCommand,
        { type: "email_request.record" }
      >;
      assert.equal(record.emailStatus, "discarded");
      assert.equal(record.wake?.notification.outcome, "cancelled");
      assert.include(record.wake?.text ?? "", "discarded");
      const again = yield* service
        .answer({
          threadId,
          turnItemId,
          answer: { type: "send", draft: drafted },
        })
        .pipe(Effect.flip);
      assert.equal(again.reason, "already_answered");
      assert.deepEqual(sent, []);
    }),
  ),
);

it.effect("sends even after the drafting run has completed, and still rejects invalid drafts", () =>
  Effect.gen(function* () {
    yield* withService(
      ({ service, sent }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "send", draft: drafted },
          });
          assert.deepEqual(sent, [drafted]);
        }),
      { runStatus: "completed" },
    );
    yield* withService(({ service, sent }) =>
      Effect.gen(function* () {
        const noRecipients = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: { type: "send", draft: { ...drafted, to: [] } },
          })
          .pipe(Effect.flip);
        assert.equal(noRecipients.reason, "no_recipients");
        const unknown = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: { type: "send", draft: { ...drafted, account: "work" } },
          })
          .pipe(Effect.flip);
        assert.equal(unknown.reason, "unknown_account");
        assert.deepEqual(sent, []);
      }),
    );
  }),
);

it.effect("a failed send leaves the card pending and says why", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: { type: "send", draft: drafted },
          })
          .pipe(Effect.flip);
        assert.equal(error.message, "Could not send the email. 535 Authentication failed");
        assert.deepEqual(dispatched, []);
      }),
    { sendFails: true },
  ),
);

const draftInput = {
  threadId,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  requestNamespace: "test",
  request: { to: ["prof@school.edu"], subject: "Office hours", body: "Hi" },
};

it.effect(
  "a native inbox reply returns pending immediately and preserves server-derived threading after user edits",
  () =>
    withService(({ service, sent, dispatched }) =>
      Effect.gen(function* () {
        const result = yield* service.draft({
          ...draftInput,
          request: {
            ...draftInput.request,
            to: [],
            replyTo: { account: "gmail", messageId: "original@example.invalid" },
          },
        });
        assert.equal(result.status, "pending");
        const pending = dispatched[0] as Extract<
          OrchestrationV2ServerCommand,
          { type: "email_request.record" }
        >;
        assert.equal(pending.draft.account, "gmail");
        assert.deepEqual(pending.draft.to, ["reply@example.invalid"]);
        assert.equal(pending.draft.inReplyTo, "<original@example.invalid>");
        assert.deepEqual(sent, []);
        yield* service.answer({
          threadId,
          turnItemId: pending.turnItemId,
          answer: {
            type: "send",
            draft: {
              ...drafted,
              account: "gmail",
              to: ["reply@example.invalid"],
              subject: "User edited subject",
            },
          },
        });
        assert.equal(sent[0]?.inReplyTo, "<original@example.invalid>");
        assert.deepEqual(sent[0]?.references, [
          "<earlier@example.invalid>",
          "<original@example.invalid>",
        ]);
      }),
    ),
);

it.effect("retrying with the same clientRequestId returns the card's current outcome", () =>
  withService(({ service, dispatched }) =>
    Effect.gen(function* () {
      const request = { ...draftInput.request, clientRequestId: "draft-1" };
      const first = yield* service.draft({ ...draftInput, request });
      if (first.status !== "pending") {
        assert.fail(`Expected pending draft, got ${first.status}`);
      }
      const second = yield* service.draft({ ...draftInput, request });
      assert.deepEqual(second, first);
      assert.equal(dispatched.length, 1);

      const edited = {
        ...drafted,
        account: "gmail",
        to: ["prof@school.edu", "ta@school.edu"],
        cc: ["advisor@school.edu"],
        bcc: ["ada@gmail.com"],
      };
      yield* service.answer({
        threadId,
        turnItemId: first.turnItemId,
        answer: { type: "send", draft: edited },
      });
      const afterSend = yield* service.draft({ ...draftInput, request });
      assert.deepEqual(afterSend, {
        status: "sent",
        message: "Email sent.",
        from: "Ada <ada@gmail.com>",
        to: edited.to,
        cc: edited.cc,
        bcc: edited.bcc,
        subject: "Office hours",
        edited: ["from", "to", "cc", "bcc", "body"],
      });
    }),
  ),
);
