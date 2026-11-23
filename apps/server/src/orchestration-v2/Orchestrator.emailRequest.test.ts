import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { emailRecordReplaces } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for email card lifecycle"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "email-request" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const accounts = [{ name: "school", from: "Ada <ada@school.edu>" }];
const draft = {
  account: "school",
  to: ["prof@school.edu"],
  cc: [],
  bcc: [],
  subject: "Office hours",
  body: "Can we meet Tuesday?",
};

const seedPendingDraft = (suffix: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:email-${suffix}`);
    const turnItemId = TurnItemId.make(`turn-item:email-request:${suffix}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-email-${suffix}`),
      threadId,
      projectId: ProjectId.make(`project:email-${suffix}`),
      title: "Email draft",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start-email-${suffix}`),
      threadId,
      messageId: MessageId.make(`message:email-${suffix}`),
      text: "Draft an email",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
    yield* orchestrator.dispatch({
      type: "email_request.record",
      commandId: CommandId.make(`record-email-pending-${suffix}`),
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      turnItemId,
      accounts,
      draft,
      emailStatus: "pending",
    });
    const now = yield* DateTime.now;
    // Finish the drafting run so the card lives past its run, just as in production.
    yield* projections.apply({
      id: EventId.make(`event:email-run-done:${suffix}`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    return { orchestrator, projections, threadId, run, turnItemId };
  });

it("answers an email card once, but a send outranks a close that raced it", () => {
  assert.isTrue(emailRecordReplaces("pending", "sent"));
  assert.isTrue(emailRecordReplaces("pending", "cancelled"));
  assert.isFalse(emailRecordReplaces("pending", "pending"));
  assert.isTrue(emailRecordReplaces("cancelled", "sent"));
  assert.isFalse(emailRecordReplaces("sent", "cancelled"));
  assert.isFalse(emailRecordReplaces("discarded", "sent"));
  assert.isFalse(emailRecordReplaces("cancelled", "discarded"));
});

it.effect(
  "keeps an open email card waiting after its run completes, skips auto-settle, and wakes the agent on send",
  () =>
    Effect.gen(function* () {
      const { orchestrator, projections, threadId, run, turnItemId } =
        yield* seedPendingDraft("send");

      // Both projection-derived and SQL-derived shells report the waiting draft after the run ends.
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.pendingRuntimeRequest?.id, RuntimeRequestId.make(turnItemId));
      const fromProjection = ProjectionStore.threadShellFromProjection(
        yield* projections.getThreadProjection(threadId),
      );
      assert.equal(fromProjection.pendingRuntimeRequest?.id, RuntimeRequestId.make(turnItemId));

      // Auto-settle must not sweep a thread with a waiting email draft.
      const candidates = yield* projections.getSettlementCandidates(threadId);
      assert.deepEqual(candidates, []);

      // Deferred turn-end settle refuses while an email draft is still pending.
      const deferredSettle = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("deferred-settle-email"),
          threadId,
          expectedLatestRunId: run.id,
        }),
      );
      assert.isTrue(Exit.isFailure(deferredSettle));

      const editedDraft = { ...draft, subject: "Office hours (Tue)" };
      yield* orchestrator.dispatch({
        type: "email_request.record",
        commandId: CommandId.make("record-email-sent"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        turnItemId,
        accounts,
        draft: editedDraft,
        emailStatus: "sent",
        edited: ["subject"],
        wake: {
          messageId: MessageId.make(`message:email-request:${turnItemId}`),
          text: 'The user sent the email "Office hours (Tue)" from Ada <ada@school.edu> to prof@school.edu.',
          notification: {
            source: { kind: "background_task" },
            outcome: "completed",
            summary: "Sent “Office hours (Tue)”",
          },
        },
      });

      const afterSend = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"], {
        turnItemTypes: ["email_request"],
      });
      const item = afterSend.turnItems.find((candidate) => candidate.id === turnItemId);
      assert.equal(item?.type === "email_request" ? item.emailStatus : null, "sent");
      assert.deepEqual(item?.type === "email_request" ? item.edited : null, ["subject"]);
      assert.isTrue(
        afterSend.messages.some(
          (message) =>
            message.id === MessageId.make(`message:email-request:${turnItemId}`) &&
            message.text.includes("Office hours (Tue)"),
        ),
      );
      assert.isNull((yield* projections.getThreadShell(threadId))?.pendingRuntimeRequest);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("manual settle and archive close open email cards and clear waiting state", () =>
  Effect.gen(function* () {
    const settled = yield* seedPendingDraft("settle");
    yield* settled.orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("manual-settle-email"),
      threadId: settled.threadId,
    });
    const settledItem = (yield* settled.projections.getThreadRecords(
      settled.threadId,
      ["turnItems"],
      {
        turnItemTypes: ["email_request"],
      },
    )).turnItems[0];
    assert.equal(
      settledItem?.type === "email_request" ? settledItem.emailStatus : null,
      "cancelled",
    );
    assert.isNull(
      (yield* settled.projections.getThreadShell(settled.threadId))?.pendingRuntimeRequest,
    );

    const archived = yield* seedPendingDraft("archive");
    yield* archived.orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-email"),
      threadId: archived.threadId,
    });
    const archivedItem = (yield* archived.projections.getThreadRecords(
      archived.threadId,
      ["turnItems"],
      {
        turnItemTypes: ["email_request"],
      },
    )).turnItems[0];
    assert.equal(
      archivedItem?.type === "email_request" ? archivedItem.emailStatus : null,
      "cancelled",
    );
  }).pipe(Effect.provide(layerTest)),
);
