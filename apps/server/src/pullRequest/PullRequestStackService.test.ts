import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  PullRequestOperationError,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestStackService from "./PullRequestStackService.ts";

const PROJECT_ID = ProjectId.make("stack-project");
const REPOSITORY = "acme/app";
const AT = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");

const testRandom = SecureRandom.make((size) => new Uint8Array(size).fill(1));

function thread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function link(
  number: number,
  snapshot: { readonly head: string; readonly base: string; readonly state?: "open" | "closed" },
  native = false,
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: REPOSITORY,
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    source: "created",
    linkedAt: "2026-11-01T00:00:00.000Z",
    snapshot: {
      state: snapshot.state ?? "open",
      title: `#${number}`,
      headBranch: snapshot.head,
      baseBranch: snapshot.base,
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-11-01T00:00:00.000Z",
    },
    stack: native
      ? {
          kind: "native",
          id: "stack-1",
          number: 9,
          url: "https://github.com/acme/app/stacks/9",
          base: "main",
          layers: [],
        }
      : null,
  };
}

function summary(
  number: number,
  head: string,
  base: string,
  state: PullRequestSummary["state"] = "open",
): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    number,
    title: `#${number}`,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    state,
    headBranch: head,
    baseBranch: base,
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const makeService = Effect.fn("makeStackService")(function* (input: {
  readonly root: string;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly summaries: ReadonlyArray<PullRequestSummary>;
  readonly failMerge?: number;
}) {
  const summaries = new Map(input.summaries.map((entry) => [entry.number, entry]));
  const summaryReads: number[] = [];
  const retargets: Array<{ readonly number: number; readonly baseBranch: string }> = [];
  const merges: number[] = [];
  const commands: OrchestrationV2ServerCommand[] = [];
  const found = (number: number) => {
    const entry = summaries.get(number);
    return entry === undefined ? Effect.die(new Error(`no #${number}`)) : Effect.succeed(entry);
  };
  const service = yield* PullRequestStackService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(PullRequestService.PullRequestService)({
          summary: (ref) =>
            Effect.sync(() => summaryReads.push(ref.number)).pipe(
              Effect.andThen(found(ref.number)),
            ),
          changeBaseBranch: (ref) =>
            found(ref.number).pipe(
              Effect.map((entry) => {
                retargets.push({ number: ref.number, baseBranch: ref.baseBranch });
                summaries.set(ref.number, { ...entry, baseBranch: ref.baseBranch });
              }),
            ),
          runAction: (ref) =>
            ref.number === input.failMerge
              ? Effect.fail(
                  new PullRequestOperationError({ operation: "runAction", detail: "Refused." }),
                )
              : found(ref.number).pipe(
                  Effect.map((entry) => {
                    merges.push(ref.number);
                    summaries.set(ref.number, { ...entry, state: "merged" });
                    return undefined;
                  }),
                ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: input.threads,
              archivedThreads: [],
            }),
          getThreadShell: (threadId) =>
            Effect.succeed(input.threads.find((candidate) => candidate.id === threadId) ?? null),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: () =>
            Effect.succeedSome({
              id: PROJECT_ID,
              title: "app",
              workspaceRoot: input.root,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-11-01T00:00:00.000Z",
              updatedAt: "2026-11-01T00:00:00.000Z",
            }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => commands.push(command)).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.succeed(SecureRandom.SecureRandom, testRandom),
      ),
    ),
  );
  return { service, summaryReads, retargets, merges, commands };
});

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-stack-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layerTest)("PullRequestStackService", (it) => {
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    GitVcsDriver.GitVcsDriver.pipe(
      Effect.flatMap((driver) =>
        driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
      ),
      Effect.map((result) => result.stdout.trim()),
    );
  const commit = (cwd: string, file: string, message: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.writeFileString(path.join(cwd, file), `${message}\n`);
      yield* git(cwd, ["add", file]);
      yield* git(cwd, ["commit", "-m", message]);
    });
  /** main <- a <- b <- c, with b and c checked out in their own worktrees. */
  const makeRepository = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-stack-repo-" });
    yield* git(root, ["init", "--initial-branch=main"]);
    yield* git(root, ["config", "user.email", "test@test.com"]);
    yield* git(root, ["config", "user.name", "Test"]);
    yield* commit(root, "README.md", "initial");
    yield* git(root, ["checkout", "-b", "a"]);
    yield* commit(root, "a.txt", "a work");
    const worktrees = {
      b: path.join(root, "..", `${path.basename(root)}-b`),
      c: path.join(root, "..", `${path.basename(root)}-c`),
    };
    yield* git(root, ["worktree", "add", "-b", "b", worktrees.b, "a"]);
    yield* commit(worktrees.b, "b.txt", "b work");
    yield* git(root, ["worktree", "add", "-b", "c", worktrees.c, "b"]);
    yield* commit(worktrees.c, "c.txt", "c work");
    yield* git(root, ["checkout", "main"]);
    yield* Effect.addFinalizer(() =>
      Effect.forEach(Object.values(worktrees), (worktree) =>
        fileSystem.remove(worktree, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    return { root, worktrees };
  });

  describe("after a merge", () => {
    it.effect(
      "retargets only open, linked, host-unstacked pull requests based on the merged branch",
      () =>
        Effect.gen(function* () {
          const { root, worktrees } = yield* makeRepository;
          yield* git(root, ["config", "branch.b.t3-merge-base", "a"]);
          yield* git(root, ["config", "branch.b.t3-merge-base-ref", "refs/remotes/origin/a"]);
          const threads = [
            thread("a", { branch: "a", pullRequests: [link(1, { head: "a", base: "main" })] }),
            thread("b", {
              branch: "b",
              baseBranch: "a",
              worktreePath: worktrees.b,
              pullRequests: [link(2, { head: "b", base: "a" })],
            }),
            thread("native", { pullRequests: [link(3, { head: "n", base: "a" }, true)] }),
            thread("closed", {
              pullRequests: [link(4, { head: "x", base: "a", state: "closed" })],
            }),
            thread("stale", { pullRequests: [link(5, { head: "s", base: "a" })] }),
            thread("elsewhere", { pullRequests: [link(6, { head: "e", base: "main" })] }),
          ];
          const harness = yield* makeService({
            root,
            threads,
            summaries: [
              summary(1, "a", "main", "merged"),
              summary(2, "b", "a"),
              summary(3, "n", "a"),
              summary(4, "x", "a", "closed"),
              summary(5, "s", "main"),
              summary(6, "e", "main"),
            ],
          });
          const merged = {
            projectId: PROJECT_ID,
            repository: REPOSITORY,
            number: 1,
            mergedAt: "2026-11-02T00:00:00.000Z",
            headBranch: "a",
            baseBranch: "main",
            restackDependents: false,
          };

          const report = yield* harness.service.afterMerge(merged);
          assert.deepStrictEqual(yield* harness.service.afterMerge(merged), report);

          assert.deepStrictEqual(report, { retargeted: [2], failed: [], restacks: [] });
          assert.deepStrictEqual(harness.retargets, [{ number: 2, baseBranch: "main" }]);
          assert.sameMembers(harness.summaryReads, [2, 5]);
          assert.deepStrictEqual(
            harness.commands.map((command) =>
              command.type === "thread.metadata.update"
                ? { threadId: command.threadId, baseBranch: command.baseBranch }
                : command.type,
            ),
            [{ threadId: ThreadId.make("b"), baseBranch: "main" }],
          );
          assert.equal(yield* git(root, ["config", "branch.b.t3-merge-base"]), "main");
          assert.equal(
            yield* git(root, ["config", "branch.b.t3-merge-base-ref"]),
            "refs/remotes/origin/main",
          );
        }),
    );

    it.effect("restacks an idle stacked thread and asks a busy one's agent to", () =>
      Effect.gen(function* () {
        const { root, worktrees } = yield* makeRepository;
        const threads = [
          thread("b", { branch: "b", baseBranch: "a", worktreePath: worktrees.b }),
          thread("c", {
            branch: "c",
            baseBranch: "a",
            worktreePath: worktrees.c,
            activeRunId: RunId.make("run-c"),
          }),
        ];
        const harness = yield* makeService({ root, threads, summaries: [] });

        const report = yield* harness.service.afterMerge({
          projectId: PROJECT_ID,
          repository: REPOSITORY,
          number: 1,
          mergedAt: "2026-11-02T00:00:00.000Z",
          headBranch: "a",
          baseBranch: "main",
          restackDependents: true,
        });

        assert.deepStrictEqual(
          report.restacks.map(({ branch, outcome, reason }) => ({ branch, outcome, reason })),
          [
            { branch: "b", outcome: "restacked", reason: undefined },
            { branch: "c", outcome: "agent-asked", reason: "busy" },
          ],
        );
        assert.equal(
          yield* git(worktrees.b, ["rev-parse", "HEAD~1"]),
          yield* git(root, ["rev-parse", "main"]),
        );
        const message = harness.commands.find((command) => command.type === "message.dispatch");
        assert.equal(message?.type === "message.dispatch" ? message.threadId : null, "c");
        assert.include(
          message?.type === "message.dispatch" ? message.text : "",
          "git rebase --onto main --fork-point a",
        );
      }),
    );
  });

  it.effect("rebases the threads stacked on a thread onto its new commits", () =>
    Effect.gen(function* () {
      const { root, worktrees } = yield* makeRepository;
      yield* commit(worktrees.b, "b2.txt", "more b work");
      yield* commit(worktrees.c, "c2.txt", "c work 2");
      const threads = [
        thread("b", { branch: "b", baseBranch: "a", worktreePath: worktrees.b }),
        thread("c", { branch: "c", baseBranch: "b", worktreePath: worktrees.c }),
      ];
      const harness = yield* makeService({ root, threads, summaries: [] });

      const result = yield* harness.service.restackDependents({ threadId: ThreadId.make("b") });

      assert.deepStrictEqual(
        result.threads.map(({ branch, onto, outcome }) => ({ branch, onto, outcome })),
        [{ branch: "c", onto: "b", outcome: "restacked" }],
      );
      assert.equal(
        yield* git(worktrees.c, ["merge-base", "HEAD", "b"]),
        yield* git(worktrees.b, ["rev-parse", "HEAD"]),
      );
      assert.equal(yield* git(worktrees.c, ["log", "--format=%s", "b..HEAD"]), "c work 2\nc work");
    }),
  );

  describe("merging up to a pull request", () => {
    const stack = (worktrees: { readonly b: string; readonly c: string }, busy?: "b") => ({
      threads: [
        thread("a", { branch: "a", pullRequests: [link(1, { head: "a", base: "main" })] }),
        thread("b", {
          branch: "b",
          baseBranch: "a",
          worktreePath: worktrees.b,
          pullRequests: [link(2, { head: "b", base: "a" })],
          ...(busy === "b" ? { activeRunId: RunId.make("run-b") } : {}),
        }),
        thread("c", {
          branch: "c",
          baseBranch: "b",
          worktreePath: worktrees.c,
          pullRequests: [link(3, { head: "c", base: "b" })],
        }),
      ],
      summaries: [summary(1, "a", "main"), summary(2, "b", "a"), summary(3, "c", "b")],
    });
    const target = { projectId: PROJECT_ID, repository: REPOSITORY, number: 3 };

    it.effect("merges the lowest open layer first and restacks each next one", () =>
      Effect.gen(function* () {
        const { root, worktrees } = yield* makeRepository;
        const harness = yield* makeService({ root, ...stack(worktrees) });

        assert.deepStrictEqual(yield* harness.service.mergeStack(target), { merged: [1, 2, 3] });
        assert.deepStrictEqual(harness.merges, [1, 2, 3]);
        assert.deepStrictEqual(harness.retargets, [
          { number: 2, baseBranch: "main" },
          { number: 3, baseBranch: "main" },
        ]);
        assert.equal(yield* git(worktrees.c, ["log", "--format=%s", "main..HEAD"]), "c work");
      }),
    );

    it.effect("stops at the first layer that cannot merge or restack unattended", () =>
      Effect.gen(function* () {
        const { root, worktrees } = yield* makeRepository;
        const busy = yield* makeService({ root, ...stack(worktrees, "b") });
        const blocked = yield* busy.service.mergeStack(target).pipe(Effect.flip);
        assert.deepStrictEqual(busy.merges, [1]);
        assert.include(blocked.message, "could not be rebased unattended");
        assert.include(blocked.message, "Merged #1 first.");

        const refused = yield* makeService({ root, ...stack(worktrees), failMerge: 2 });
        const failed = yield* refused.service.mergeStack(target).pipe(Effect.flip);
        assert.deepStrictEqual(refused.merges, [1]);
        assert.include(failed.message, "#2 could not be merged. Merged #1 first.");
      }),
    );
  });
});
