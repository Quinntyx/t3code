import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DeusConversation,
  DeusCursor,
  DeusInputId,
  DeusObservationId,
  DeusSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Context from "./DeusContextService.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Repository from "./DeusRepository.ts";
import * as Session from "./DeusSessionService.ts";

const environmentId = EnvironmentId.make("context-environment");
const projectId = ProjectId.make("context-project");
const scope = { environmentId, projectId };
const inputId = (value: string) => DeusInputId.make(value);
const services = Context.layer.pipe(
  Layer.provideMerge(Memory.layer.pipe(Layer.provideMerge(Git.layer))),
  Layer.provideMerge(Session.layer.pipe(Layer.provide(EventStore.layer))),
  Layer.provideMerge(Repository.layer),
  Layer.provide(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);
const seed = Effect.fn("ContextTest.seed")(function* (id = projectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${id}, 'Synthetic context', '/synthetic', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
});
const fixture = services.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "deus-context-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "keeps scoped corrections ahead of superseded evidence with explicit full-source reads",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const session = yield* Session.DeusSessionService;
      const context = yield* Context.DeusContextService;
      const ref = (yield* session.open({ ...scope, inputId: inputId("open") })).session;
      const first = yield* session.acceptInput({
        ...ref,
        inputId: inputId("first"),
        conversation: ref.conversation,
        text: "Use old package workflow.",
      });
      yield* context.recordObservation({
        ...ref,
        inputId: inputId("observe-first"),
        sourceCursor: first.cursor,
        kind: "context",
        text: "Use old package workflow.",
        supersedes: null,
      });
      const old = (yield* session.snapshot(ref)).observations[0]!;
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
      const root = `${config.stateDir}/deus-memory`;
      const entries = `${root}/environments/${Buffer.from(environmentId).toString("hex")}/projects/${Buffer.from(projectId).toString("hex")}/entries`;
      yield* fs.makeDirectory(entries, { recursive: true });
      const metadata = {
        id: "stale",
        revision: 1,
        scope: "project",
        environmentId,
        projectId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        observationIds: [old.id],
        sources: [old.source],
        supersedes: null,
      };
      yield* fs.writeFileString(
        `${entries}/stale.md`,
        `<!-- deus-memory:v1 ${JSON.stringify(metadata)} -->\n\nUse old package workflow.`,
      );
      yield* fs.writeFileString(
        `${entries}/retained.md`,
        `<!-- deus-memory:v1 ${JSON.stringify({ ...metadata, id: "retained", observationIds: [], sources: [] })} -->\n\nIndependent retained memory.`,
      );
      for (const args of [
        ["init"],
        ["add", "--all"],
        [
          "-c",
          "user.name=Synthetic fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "Synthetic context fixture",
        ],
      ])
        yield* git.execute({ cwd: root, args, operation: "context-test-fixture" });
      assert.lengthOf((yield* context.contextForInput({ ...ref, query: "" })).memory.items, 2);
      const fullText = "Correction: use the new workflow. " + "🧭".repeat(3000);
      const next = yield* session.acceptInput({
        ...ref,
        inputId: inputId("next"),
        conversation: ref.conversation,
        text: fullText,
      });
      const correction = {
        ...ref,
        inputId: inputId("correct"),
        sourceCursor: next.cursor,
        kind: "correction" as const,
        text: fullText,
        supersedes: old.id,
      };
      const repository = yield* Repository.DeusRepository;
      let corrected = false;
      const concurrent = Layer.fresh(Context.layer).pipe(
        Layer.provide(
          Layer.succeed(Repository.DeusRepository, {
            ...repository,
            snapshot: Effect.fn("ContextTest.concurrentSnapshot")(function* (input) {
              const captured = yield* repository.snapshot(input);
              if (!corrected) {
                corrected = true;
                yield* context.recordObservation(correction);
              }
              return captured;
            }),
          }),
        ),
      );
      const during = yield* Effect.gen(function* () {
        return yield* (yield* Context.DeusContextService).contextForInput({ ...ref, query: "" });
      }).pipe(Effect.provide(concurrent));
      assert.equal(during.working.items[0]?.id, old.id);
      assert.deepEqual(
        during.memory.items.map((entry) => entry.id),
        ["retained", "stale"],
      );
      assert.equal((yield* context.recordObservation(correction)).status, "replayed");
      const result = yield* context.contextForInput({ ...ref, query: "old package" });
      assert.isTrue(result.evidenceOnly);
      assert.lengthOf(result.working.items, 1);
      assert.lengthOf(result.memory.items, 0);
      const preview = result.working.items[0]!;
      assert.equal(preview.kind, "correction");
      assert.equal(preview.supersedes, old.id);
      assert.isTrue(preview.truncated);
      assert.include(preview.text, "[Preview;");
      assert.isAtMost(preview.text.length, 2000);
      assert.isAtMost(Buffer.byteLength(preview.text), 4000);
      const full = yield* context.readObservation({ ...ref, observationId: preview.id });
      assert.equal(full.observation.text, fullText);
      assert.equal(full.source.change.type, "transcript");
      if (full.source.change.type === "transcript")
        assert.equal(full.source.change.transcript.text, fullText);
      assert.equal(full.source.cursor, next.cursor);
      assert.equal(
        (yield* context.readObservation({ ...ref, observationId: old.id })).observation.text,
        old.text,
      );
      assert.lengthOf(
        (yield* context.search({ ...ref, query: "old", includeSuperseded: true })).items,
        2,
      );
      yield* session.resetConversation({
        ...ref,
        inputId: inputId("reset"),
        conversation: ref.conversation,
      });
      assert.lengthOf(
        (yield* context.contextForInput({ ...ref, query: "unrelated" })).working.items,
        1,
      );
      assert.lengthOf((yield* context.contextForInput({ ...ref, query: "" })).memory.items, 1);
      assert.equal(
        (yield* (yield* Memory.DeusMemoryService).read({ ...ref, id: "stale", scope: "project" }))
          .text,
        "Use old package workflow.",
      );
      yield* seed(ProjectId.make("other-project"));
      const other = (yield* session.open({
        environmentId,
        projectId: ProjectId.make("other-project"),
        inputId: inputId("other-open"),
      })).session;
      assert.lengthOf((yield* context.search({ ...other, query: "" })).items, 0);
      assert.equal(
        (yield* context.readSource({ ...other, cursor: next.cursor }).pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* context
          .recordObservation({
            ...other,
            inputId: inputId("cross-correction"),
            sourceCursor: next.cursor,
            kind: "correction",
            supersedes: old.id,
            text: "Cross-project correction",
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      for (const bad of [
        { ...ref, environmentId: EnvironmentId.make("foreign") },
        { ...ref, sessionId: DeusSessionId.make("foreign") },
        { ...ref, projectId: ProjectId.make("foreign") },
      ])
        assert.equal(
          (yield* context.search({ ...bad, query: "" }).pipe(Effect.flip))._tag,
          "DeusStateError",
        );
      assert.equal(
        (yield* context
          .recordObservation({
            ...correction,
            inputId: inputId("forged"),
            supersedes: DeusObservationId.make("missing"),
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* context
          .recordObservation({
            ...correction,
            inputId: inputId("bad-source"),
            sourceCursor: DeusCursor.make(999),
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* context
          .recordObservation({
            ...correction,
            inputId: inputId("generated-source"),
            sourceCursor: DeusCursor.make(2),
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "excludes corrected memory before the result limit so retained evidence is not starved",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const session = yield* Session.DeusSessionService;
      const context = yield* Context.DeusContextService;
      const ref = (yield* session.open({ ...scope, inputId: inputId("open") })).session;
      const first = yield* session.acceptInput({
        ...ref,
        inputId: inputId("first"),
        conversation: ref.conversation,
        text: "Old workflow",
      });
      yield* context.recordObservation({
        ...ref,
        inputId: inputId("observe"),
        sourceCursor: first.cursor,
        kind: "context",
        text: "Old workflow",
        supersedes: null,
      });
      const old = (yield* session.snapshot(ref)).observations[0]!;
      const next = yield* session.acceptInput({
        ...ref,
        inputId: inputId("next"),
        conversation: ref.conversation,
        text: "New workflow",
      });
      yield* context.recordObservation({
        ...ref,
        inputId: inputId("correct"),
        sourceCursor: next.cursor,
        kind: "correction",
        text: "New workflow",
        supersedes: old.id,
      });
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
      const root = `${config.stateDir}/deus-memory`;
      const entries = `${root}/environments/${Buffer.from(environmentId).toString("hex")}/projects/${Buffer.from(projectId).toString("hex")}/entries`;
      yield* fs.makeDirectory(entries, { recursive: true });
      for (const id of ["a-stale", "z-retained"]) {
        const metadata = {
          id,
          revision: 1,
          scope: "project",
          environmentId,
          projectId,
          updatedAt: "2026-01-01T00:00:00.000Z",
          observationIds: id === "a-stale" ? [old.id] : [],
          sources: id === "a-stale" ? [old.source] : [],
          supersedes: null,
        };
        yield* fs.writeFileString(
          `${entries}/${id}.md`,
          `<!-- deus-memory:v1 ${JSON.stringify(metadata)} -->\n\nWorkflow evidence ${id}`,
        );
      }
      for (const args of [
        ["init"],
        ["add", "--all"],
        [
          "-c",
          "user.name=Synthetic fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "Synthetic paging fixture",
        ],
      ])
        yield* git.execute({ cwd: root, args, operation: "context-test-fixture" });
      const memory = yield* Memory.DeusMemoryService;
      assert.equal(
        (yield* memory.search({ ...ref, query: "workflow", limit: 1 })).items[0]?.id,
        "a-stale",
      );
      const result = yield* context.contextForInput({ ...ref, query: "workflow", limit: 1 });
      assert.equal(result.working.items[0]?.kind, "correction");
      assert.equal(result.memory.items[0]?.id, "z-retained");
      assert.equal(
        (yield* memory.read({ ...ref, scope: "project", id: "a-stale" })).text,
        "Workflow evidence a-stale",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "reopens file SQLite with one full report observation and original late-run provenance",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "deus-context-reopen-" });
      const isolated = services.pipe(Layer.provideMerge(Config.layerTest(process.cwd(), home)));
      const first = yield* Effect.gen(function* () {
        yield* seed();
        const session = yield* Session.DeusSessionService;
        const ref = (yield* session.open({ ...scope, inputId: inputId("open") })).session;
        const launch = yield* session.prepareLaunch({
          ...ref,
          inputId: inputId("launch"),
          conversation: ref.conversation,
          prompt: "Synthetic task",
          kind: "work",
          model: { instanceId: ProviderInstanceId.make("fixture"), model: "no-model-call" },
          runtimeMode: "full-access",
          workspace: "project",
        });
        const pending = (yield* session.pending)[0]!;
        if (pending.intent.type !== "launch-thread") return assert.fail("Missing launch intent");
        const runId = RunId.make("original-run");
        yield* session.acknowledgeLaunch({
          ...ref,
          inputId: inputId("ack"),
          taskId: launch.task.id,
          threadId: pending.intent.threadId,
          commandId: pending.intent.commandId,
          runId,
        });
        yield* session.resetConversation({
          ...ref,
          inputId: inputId("reset"),
          conversation: DeusConversation.make(1),
        });
        const report = {
          ...ref,
          inputId: inputId("report"),
          taskId: launch.task.id,
          threadId: pending.intent.threadId,
          runId,
          mode: "SILENT" as const,
          text: "Full synthetic report " + "evidence ".repeat(1200) + "end",
        };
        const receipt = yield* session.recordReport(report);
        return { ref, report, receipt, snapshot: yield* session.snapshot(ref) };
      }).pipe(
        Effect.provide(
          isolated.pipe(Layer.provideMerge(Sqlite.layerFromPath(`${home}/state.sqlite`))),
        ),
        Effect.scoped,
      );
      yield* Effect.gen(function* () {
        const session = yield* Session.DeusSessionService;
        const context = yield* Context.DeusContextService;
        assert.equal((yield* session.recordReport(first.report)).status, "replayed");
        const current = yield* session.snapshot(first.ref);
        assert.deepEqual(current, first.snapshot);
        assert.lengthOf(current.observations, 1);
        const observation = current.observations[0]!;
        assert.equal(observation.conversation, 1);
        assert.equal(current.session.conversation, 2);
        const full = yield* context.readObservation({
          ...first.ref,
          observationId: observation.id,
        });
        assert.equal(full.source.cursor, first.receipt.cursor - 1);
        assert.equal(full.source.change.type, "report");
        if (full.source.change.type === "report")
          assert.deepInclude(full.source.change.report, {
            runId: first.report.runId,
            threadId: first.report.threadId,
            taskId: first.report.taskId,
            text: first.report.text,
            conversation: DeusConversation.make(1),
          });
        assert.equal(
          (yield* context
            .recordObservation({
              ...first.ref,
              inputId: inputId("worker-correction"),
              sourceCursor: full.source.cursor,
              kind: "correction",
              text: "Worker cannot claim a human correction",
              supersedes: observation.id,
            })
            .pipe(Effect.flip))._tag,
          "DeusStateError",
        );
        yield* Effect.logInfo(
          "STEP04: real file SQLite close/reopen; synthetic report replay retained one full observation, original run/task/conversation/source cursor; no models or workers executed.",
        );
      }).pipe(
        Effect.provide(
          isolated.pipe(Layer.provideMerge(Sqlite.layerFromPath(`${home}/state.sqlite`))),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
