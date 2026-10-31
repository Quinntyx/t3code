import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EmailRequestError,
  type OrchestrationV2EmailDraft,
  type OrchestrationV2EmailRequestStatus,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { emailRecordReplaces } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as EmailRequests from "./EmailRequests.ts";
import * as Mailer from "./Mailer.ts";

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
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(
        Mailer.Mailer,
        Mailer.Mailer.of({
          accounts: Effect.succeed(accounts),
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
                    draft: drafted,
                    emailStatus,
                  },
                ],
              }) as never,
          ).pipe(Effect.tap(() => Effect.yieldNow)),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (command.type !== "email_request.record") return {} as never;
            cardId = command.turnItemId;
            if (emailRecordReplaces(emailStatus, command.emailStatus)) {
              emailStatus = command.emailStatus;
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

it.effect("sends the user's edited email and records what was sent", () =>
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
      assert.include(dispatched[0] as object, {
        type: "email_request.record",
        emailStatus: "sent",
      });
      assert.deepEqual((dispatched[0] as { draft: unknown }).draft, edited);
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

it.effect("discarding sends nothing, and a card is answered once", () =>
  withService(({ service, sent, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "discard" },
      });
      assert.include(dispatched[0] as object, { emailStatus: "discarded" });
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

it.effect(
  "refuses to send for an agent that stopped, or without recipients or a known account",
  () =>
    Effect.gen(function* () {
      yield* withService(
        ({ service, sent }) =>
          Effect.gen(function* () {
            const error = yield* service
              .answer({
                threadId,
                turnItemId,
                answer: { type: "send", draft: drafted },
              })
              .pipe(Effect.flip);
            assert.equal(error.reason, "agent_stopped");
            assert.deepEqual(sent, []);
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
  request: { to: ["prof@school.edu"], subject: "Office hours", body: "Hi", timeoutMs: 1_000 },
};

it.effect("a draft nobody answers closes and reports that it timed out", () =>
  withService(({ service, dispatched }) =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(service.draft(draftInput));
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(yield* Fiber.join(waiting), { status: "timed_out" });
      assert.deepEqual(
        dispatched.map((command) => (command as { emailStatus?: string }).emailStatus),
        ["pending", "cancelled"],
      );
    }),
  ),
);

it.effect("a send in flight when the wait times out is reported as sent", () =>
  Effect.gen(function* () {
    const sendGate = { started: yield* Deferred.make<void>(), open: yield* Deferred.make<void>() };
    yield* withService(
      ({ service, dispatched }) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(service.draft(draftInput));
          yield* TestClock.adjust("600 millis");
          const pending = dispatched[0] as { turnItemId: TurnItemId };
          const sending = yield* Effect.forkChild(
            service.answer({
              threadId,
              turnItemId: pending.turnItemId,
              answer: { type: "send", draft: drafted },
            }),
          );
          yield* Deferred.await(sendGate.started);
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.succeed(sendGate.open, undefined);
          yield* Fiber.join(sending);
          assert.include(yield* Fiber.join(waiting), { status: "sent", message: "Email sent." });
        }),
      { sendGate },
    );
  }),
);
