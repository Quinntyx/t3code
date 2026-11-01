import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DeusInputId,
  DeusMemoryId,
  DeusStateError,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Repository from "./DeusRepository.ts";
import * as Writer from "./DeusMemoryWriter.ts";

const environmentId = EnvironmentId.make("memory-environment");
const projectId = ProjectId.make("memory-project");
const fixture = Writer.layer.pipe(
  Layer.provideMerge(Memory.layer),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provide(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "deus-memory-" })),
  Layer.provideMerge(NodeServices.layer),
);
const hex = (value: string) => Buffer.from(value).toString("hex");
const directory = (scope: "project" | "environment" | "global", id = projectId) =>
  scope === "global"
    ? "global/entries"
    : scope === "environment"
      ? `environments/${hex(environmentId)}/entries`
      : `environments/${hex(environmentId)}/projects/${hex(id)}/entries`;
const markdown = (
  id: string,
  text: string,
  scope: "project" | "environment" | "global" = "project",
  project: ProjectId = projectId,
) =>
  `<!-- deus-memory:v1 ${JSON.stringify({ id, revision: 1, scope, environmentId: scope === "global" ? null : environmentId, projectId: scope === "project" ? project : null, updatedAt: "2026-01-01T00:00:00.000Z", observationIds: [], sources: [], supersedes: null })} -->\n\n${text}`;
const setup = Effect.fn("MemoryTest.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${projectId}, 'Synthetic memory', '/synthetic', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  const ref = (yield* (yield* Repository.DeusRepository).open({
    environmentId,
    projectId,
    inputId: DeusInputId.make("open"),
  })).session;
  const config = yield* Config.ServerConfig;
  const root = `${config.stateDir}/deus-memory`;
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git.GitVcsDriver;
  const execute = (args: ReadonlyArray<string>) =>
    git.execute({ cwd: root, args, operation: "memory-test-fixture" });
  const write = Effect.fn("MemoryTest.write")(function* (
    scope: "project" | "environment" | "global",
    id: string,
    body: string,
    project = projectId,
  ) {
    const dir = `${root}/${directory(scope, project)}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/${id}.md`, body);
  });
  const commit = Effect.fn("MemoryTest.commit")(function* () {
    yield* execute(["add", "--all"]);
    yield* execute([
      "-c",
      "user.name=Synthetic fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Synthetic memory fixture",
    ]);
  });
  return { root, fs, execute, write, commit, ref, memory: yield* Memory.DeusMemoryService };
});

it.effect(
  "reads committed full Markdown with scoped lexical previews and never creates a repository",
  () =>
    Effect.gen(function* () {
      const { root, fs, execute, write, commit, ref, memory } = yield* setup();
      assert.deepEqual((yield* memory.search({ ...ref, query: "" })).items, []);
      assert.isFalse(yield* fs.exists(root));
      yield* fs.makeDirectory(root, { recursive: true });
      yield* execute(["init"]);
      const full = "Synthetic calibration " + "🧭".repeat(4000);
      yield* write("project", "calibration", markdown("calibration", full));
      yield* write(
        "environment",
        "environment-note",
        markdown("environment-note", "Synthetic environment preference", "environment"),
      );
      yield* write(
        "global",
        "global-note",
        markdown("global-note", "Synthetic global preference", "global"),
      );
      const other = ProjectId.make("another-project");
      yield* write(
        "project",
        "foreign",
        markdown("foreign", "Never leak another project", "project", other),
        other,
      );
      yield* commit();
      const before = (yield* execute(["rev-parse", "HEAD"])).stdout.trim();
      const result = yield* memory.search({ ...ref, query: "calibration" });
      assert.lengthOf(result.items, 1);
      assert.isTrue(result.items[0]!.truncated);
      assert.include(result.items[0]!.text, "[Preview;");
      assert.isAtMost(Buffer.byteLength(JSON.stringify(result.items)), 32000);
      const entry = yield* memory.read({
        ...ref,
        scope: "project",
        id: "calibration",
        revision: 1,
      });
      assert.equal(
        (yield* memory.read({ ...ref, scope: "global", id: "global-note" })).scope,
        "global",
      );
      assert.equal(
        (yield* memory.read({ ...ref, scope: "environment", id: "environment-note" })).scope,
        "environment",
      );
      assert.equal(entry.text, full);
      assert.equal(entry.commit, before);
      assert.equal(
        (yield* memory
          .read({ ...ref, scope: "project", id: "calibration", revision: 2 })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* memory.read({ ...ref, scope: "project", id: "missing" }).pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.lengthOf((yield* memory.search({ ...ref, query: "" })).items, 1);
      assert.lengthOf(
        (yield* memory.search({ ...ref, query: "", scopes: ["project", "environment", "global"] }))
          .items,
        3,
      );
      assert.lengthOf((yield* memory.briefing(ref)).items, 1);
      assert.lengthOf((yield* memory.search({ ...ref, query: "foreign" })).items, 0);
      assert.lengthOf((yield* memory.search({ ...ref, query: "", scopes: ["project"] })).items, 1);
      assert.equal(
        (yield* memory
          .search({ ...ref, environmentId: EnvironmentId.make("foreign"), query: "" })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      for (const id of [
        "../calibration",
        "../../outside",
        "/etc/passwd",
        "x/y",
        "x\\y",
        "..",
        "a\u0000b",
      ])
        assert.equal(
          (yield* memory.read({ ...ref, scope: "project", id }).pipe(Effect.flip))._tag,
          "DeusStateError",
        );
      assert.equal((yield* execute(["status", "--porcelain"])).stdout, "");
      assert.equal((yield* execute(["rev-parse", "HEAD"])).stdout.trim(), before);
      assert.isFalse("write" in memory);
      assert.isFalse("promote" in memory);
      const config = yield* Config.ServerConfig;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "deus-memory-link-" });
      yield* fs.symlink(root, `${empty}/deus-memory`);
      const linked = Layer.fresh(Memory.layer).pipe(
        Layer.provide(Layer.succeed(Config.ServerConfig, { ...config, stateDir: empty })),
      );
      assert.equal(
        (yield* Effect.gen(function* () {
          return yield* (yield* Memory.DeusMemoryService).search({ ...ref, query: "" });
        }).pipe(Effect.provide(linked), Effect.flip))._tag,
        "DeusStateError",
      );
      yield* Effect.logInfo(
        "STEP04: real configured-home filesystem and Git committed synthetic entries; reads left HEAD and worktree unchanged; no promotion/model execution.",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "bounds result counts, encoded previews and directory scans against committed Git entries",
  () =>
    Effect.gen(function* () {
      const { root, fs, execute, write, commit, ref, memory } = yield* setup();
      yield* fs.makeDirectory(root, { recursive: true });
      yield* execute(["init"]);
      for (let index = 0; index < 128; index++) {
        const id = `entry-${String(index).padStart(3, "0")}`;
        yield* write("project", id, markdown(id, "Synthetic bounded evidence"));
      }
      yield* commit();
      const short = yield* memory.search({ ...ref, query: "" });
      assert.lengthOf(short.items, 20);
      assert.equal(short.omitted, 108);
      const full = "Synthetic bounded evidence " + "🧭".repeat(4000);
      for (let index = 0; index < 128; index++) {
        const id = `entry-${String(index).padStart(3, "0")}`;
        yield* write("project", id, markdown(id, full));
      }
      yield* commit();
      const before = (yield* execute(["rev-parse", "HEAD"])).stdout.trim();
      const long = yield* memory.search({ ...ref, query: "" });
      assert.isAbove(long.items.length, 0);
      assert.isBelow(long.items.length, 20);
      assert.equal(long.omitted, 128 - long.items.length);
      assert.isAtMost(JSON.stringify(long.items).length, 16000);
      assert.isAtMost(Buffer.byteLength(JSON.stringify(long.items)), 32000);
      assert.isTrue(
        long.items.every((entry) => entry.truncated && entry.text.includes("[Preview;")),
      );
      assert.equal(
        (yield* memory.read({ ...ref, scope: "project", id: long.items[0]!.id })).text,
        full,
      );
      assert.lengthOf((yield* memory.search({ ...ref, query: "", limit: 2 })).items, 2);
      assert.equal((yield* execute(["status", "--porcelain"])).stdout, "");
      assert.equal((yield* execute(["rev-parse", "HEAD"])).stdout.trim(), before);
      yield* write("global", "overflow", markdown("overflow", "Synthetic overflow", "global"));
      yield* commit();
      assert.equal(
        (yield* memory
          .search({ ...ref, query: "", scopes: ["project", "global"] })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.isAbove((yield* memory.search({ ...ref, query: "" })).items.length, 0);
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "human removal is durable, replayable, revision-checked and checks authority at execution",
  () =>
    Effect.gen(function* () {
      const { root, fs, execute, write, commit, ref, memory } = yield* setup();
      yield* fs.makeDirectory(root, { recursive: true });
      yield* execute(["init"]);
      yield* write("project", "wrong", markdown("wrong", "Erroneous calibration"));
      yield* commit();
      const writer = yield* Writer.DeusMemoryWriter;
      const input = {
        ...ref,
        inputId: DeusInputId.make("human-removal"),
        memoryId: DeusMemoryId.make("wrong"),
        expectedRevision: 1,
        correction: null,
      };
      const denied = Effect.fail(
        new DeusStateError({ reason: "conflict", message: "Revoked human grant" }),
      );
      assert.equal((yield* writer.correct(input, denied).pipe(Effect.flip))._tag, "DeusStateError");
      assert.equal(
        (yield* writer.correct({ ...input, expectedRevision: 2 }, Effect.void).pipe(Effect.flip))
          ._tag,
        "DeusStateError",
      );
      const result = yield* writer.correct(input, Effect.void);
      assert.isNotNull(result.removedAt);
      assert.deepEqual(yield* writer.correct(input, Effect.void), result);
      assert.deepEqual((yield* memory.search({ ...ref, query: "calibration" })).items, []);
      assert.lengthOf((yield* (yield* Repository.DeusRepository).snapshot(ref)).memories, 1);
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "removal leaves committed correction evidence but excludes the entry from retrieval",
  () =>
    Effect.gen(function* () {
      const { root, fs, execute, write, commit, ref, memory } = yield* setup();
      yield* fs.makeDirectory(root, { recursive: true });
      yield* execute(["init"]);
      yield* write("project", "wrong", markdown("wrong", "Erroneous calibration"));
      yield* commit();
      const removal = markdown("removed", "Human removed erroneous calibration").replace(
        '"supersedes":null',
        '"supersedes":"wrong","removedAt":"2026-10-31T00:00:00.000Z"',
      );
      yield* write("project", "removed", removal);
      yield* commit();
      assert.deepEqual((yield* memory.search({ ...ref, query: "calibration" })).items, []);
      assert.deepEqual((yield* memory.briefing(ref)).items, []);
      assert.equal(
        (yield* memory.read({ ...ref, scope: "project", id: "wrong" }).pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.include(
        (yield* execute(["show", `HEAD:${directory("project")}/removed.md`])).stdout,
        "Human removed",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect("rejects malformed, oversized, dirty, wrong-scope entries and symlink escapes", () =>
  Effect.gen(function* () {
    const { root, fs, execute, write, commit, ref, memory } = yield* setup();
    yield* fs.makeDirectory(root, { recursive: true });
    yield* execute(["init"]);
    yield* write("project", "broken", "not memory metadata");
    yield* commit();
    assert.equal(
      (yield* memory.read({ ...ref, scope: "project", id: "broken" }).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    assert.equal(
      (yield* memory.search({ ...ref, query: "" }).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    yield* write("project", "broken", markdown("broken", "Repaired synthetic entry"));
    yield* write("project", "wrong", markdown("wrong", "Wrong scope", "environment"));
    yield* write("project", "oversized", markdown("oversized", "x".repeat(262144)));
    yield* commit();
    for (const id of ["wrong", "oversized"])
      assert.equal(
        (yield* memory.read({ ...ref, scope: "project", id }).pipe(Effect.flip))._tag,
        "DeusStateError",
      );
    yield* write("project", "broken", markdown("broken", "Uncommitted change"));
    assert.equal(
      (yield* memory.read({ ...ref, scope: "project", id: "broken" }).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "deus-memory-outside-" });
    yield* fs.writeFileString(
      `${outside}/escape.md`,
      markdown("escape", "Outside synthetic secret"),
    );
    yield* fs.symlink(`${outside}/escape.md`, `${root}/${directory("project")}/escape.md`);
    assert.equal(
      (yield* memory.read({ ...ref, scope: "project", id: "escape" }).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    yield* fs.makeDirectory(`${outside}/entries`);
    const foreign = ProjectId.make("symlink-project");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${foreign}, 'Synthetic symlink', '/synthetic', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    const foreignRef = (yield* (yield* Repository.DeusRepository).open({
      environmentId,
      projectId: foreign,
      inputId: DeusInputId.make("open-foreign"),
    })).session;
    yield* fs.symlink(
      outside,
      `${root}/environments/${hex(environmentId)}/projects/${hex(foreign)}`,
    );
    assert.equal(
      (yield* memory.search({ ...foreignRef, query: "" }).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
  }).pipe(Effect.provide(fixture)),
);
