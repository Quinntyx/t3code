import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

it.effect("reads file revisions from the pull request diff and refuses a truncated one", () =>
  Effect.gen(function* () {
    let truncated = false;
    const diff = [
      "diff --git a/alpha.ts b/alpha.ts",
      "index eb2d7c5..b485fe5 100644",
      "diff --git a/beta.ts b/beta.ts",
      "index b39e8b3..5851425 100644",
      'diff --git "a/caf\\303\\251 notes.txt" "b/caf\\303\\251 notes.txt"',
      "index ffd99ce..6dd9855 100644",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "index 233f5c6..0000000",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to renamed.txt",
      "",
    ].join("\n");
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.merge(
          TestSourceControlHost.layer(),
          Layer.mock(ForgejoCli.ForgejoCli)({
            api: (input) => {
              assert.strictEqual(input.host, "forge.example:3000");
              assert.strictEqual(input.repository, "reviewer/project");
              assert.strictEqual(input.path, "repos/reviewer/project/pulls/1.diff");
              return Effect.succeed({
                ...TestSourceControlHost.processOutput(diff),
                stdoutTruncated: truncated,
              });
            },
          }),
        ),
      ),
    );
    const reference = {
      cwd: "/forgejo",
      repository: "reviewer/project",
      host: "forge.example:3000",
      number: 1,
    };
    const paths = ["alpha.ts", "beta.ts", "café notes.txt", "deleted.txt", "renamed.txt"];
    assert.isDefined(provider.getFileRevisions);
    const answer = yield* provider.getFileRevisions!({ ...reference, paths });
    assert.isTrue(answer.complete);
    assert.deepStrictEqual(
      paths.map((path) => [path, answer.revisions.get(path)]),
      [
        ["alpha.ts", "b485fe5"],
        ["beta.ts", "5851425"],
        ["café notes.txt", "6dd9855"],
        ["deleted.txt", "0000000"],
        ["renamed.txt", ""],
      ],
    );

    truncated = true;
    const refused = yield* Effect.flip(provider.getFileRevisions!({ ...reference, paths }));
    assert.strictEqual(refused._tag, "PullRequestProviderError");
  }),
);

it.live(
  "proves Forgejo conflicts with real Git without touching the checkout and clears stale conflicts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { process } = yield* SourceControlHost.SourceControlHost;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-forgejo-conflicts-" });
      const git = (...args: string[]) =>
        process
          .run({
            operation: "test.setup",
            command: "git",
            cwd,
            args,
            env: {
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_AUTHOR_NAME: "Test",
              GIT_AUTHOR_EMAIL: "test@example.com",
              GIT_COMMITTER_NAME: "Test",
              GIT_COMMITTER_EMAIL: "test@example.com",
            },
          })
          .pipe(Effect.map((output) => output.stdout.trim()));
      yield* git("init", "-b", "main");
      yield* fs.writeFileString(`${cwd}/file.txt`, "original\n");
      yield* git("add", "file.txt");
      yield* git("commit", "-m", "original");
      yield* git("switch", "-c", "feature");
      yield* fs.writeFileString(`${cwd}/file.txt`, "feature\n");
      yield* git("commit", "-am", "feature");
      const head = yield* git("rev-parse", "HEAD");
      yield* git("switch", "main");
      yield* fs.writeFileString(`${cwd}/file.txt`, "main\n");
      yield* git("commit", "-am", "main");
      const base = yield* git("rev-parse", "HEAD");
      yield* fs.writeFileString(`${cwd}/file.txt`, "dirty worktree\n");
      const refs = yield* git("show-ref");
      const index = yield* git("ls-files", "--stage");
      const pull = {
        number: 1,
        title: "Conflict",
        body: "",
        html_url: "https://forgejo.test/acme/web/pulls/1",
        user: null,
        state: "open",
        merged: false,
        mergeable: false,
        draft: false,
        base: { ref: "main", sha: base, repo: null },
        head: { ref: "feature", sha: head, repo: null },
        created_at: "2026-11-02T00:00:00Z",
        updated_at: "2026-11-02T00:00:00Z",
        closed_at: null,
        merged_at: null,
        labels: [],
      };
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const provider = yield* ForgejoPullRequestProvider.make.pipe(
        Effect.provide(
          Layer.mock(ForgejoCli.ForgejoCli)({
            api: (input) => {
              assert.isUndefined(input.method);
              return encode(input.path.endsWith("pulls/1") ? pull : { full_name: "acme/web" }).pipe(
                Effect.orDie,
                Effect.map(TestSourceControlHost.processOutput),
              );
            },
          }),
        ),
      );
      const input = { cwd, repository: "acme/web", host: "forgejo.test", number: 1 };
      const read = provider.getChangeRequestSummary!;
      assert.strictEqual((yield* read(input)).mergeability, "conflicting");
      const refused = yield* Effect.flip(provider.runAction({ ...input, action: "merge" }));
      assert.include(refused.detail, "merge conflicts");
      pull.head.sha = base;
      assert.strictEqual((yield* read(input)).mergeability, "unknown");
      pull.mergeable = true;
      assert.strictEqual((yield* read(input)).mergeability, "mergeable");
      pull.mergeable = false;
      pull.head.sha = "c".repeat(40);
      assert.strictEqual((yield* read(input)).mergeability, "unknown");
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-forgejo-no-checkout-" });
      assert.strictEqual((yield* read({ ...input, cwd: outside })).mergeability, "unknown");
      assert.strictEqual(yield* git("rev-parse", "HEAD"), base);
      assert.strictEqual(yield* git("show-ref"), refs);
      assert.strictEqual(yield* git("ls-files", "--stage"), index);
      assert.strictEqual(yield* fs.readFileString(`${cwd}/file.txt`), "dirty worktree\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(TestSourceControlHost.layerWithRealGit(), NodeServices.layer)),
    ),
);

it.effect("filters listed pull requests by the requested state", () =>
  Effect.gen(function* () {
    // Forgejo answers a `state=closed` query with merged and closed-unmerged rows alike.
    const rows = [true, false].map((merged) => ({
      number: merged ? 1 : 2,
      title: `Pull request ${merged ? 1 : 2}`,
      body: "",
      html_url: `https://forge.example:3000/maria/project/pulls/${merged ? 1 : 2}`,
      user: { login: "maria" },
      state: "closed",
      merged,
      head: { ref: "feature", sha: "head-sha", repo: null },
      base: { ref: "main", sha: "base-sha", repo: null },
      created_at: "2026-10-12T00:00:00Z",
      updated_at: "2026-10-12T00:00:00Z",
      closed_at: "2026-10-13T00:00:00Z",
      merged_at: merged ? "2026-10-13T00:00:00Z" : null,
      labels: [],
    }));
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.merge(
          TestSourceControlHost.layer(),
          Layer.mock(ForgejoCli.ForgejoCli)({
            api: (input) => {
              const [path, query] = input.path.split("?");
              assert.strictEqual(path, "repos/maria/project/pulls");
              const params = new URLSearchParams(query);
              // A merged list asks Forgejo for closed rows and separates them itself.
              const state = params.get("state");
              assert.ok(state === "closed" || state === "open" || state === "all");
              const page = params.get("page") === "1" && state !== "open" ? rows : [];
              return Effect.succeed(TestSourceControlHost.processOutput(JSON.stringify(page)));
            },
          }),
        ),
      ),
    );
    const input = {
      cwd: "/forgejo",
      repository: "maria/project",
      host: "forge.example:3000",
      involvement: "all" as const,
      viewer: "maria",
      limit: 10,
    };
    const numbers = (state: "open" | "closed" | "merged" | "all") =>
      provider
        .listChangeRequests({ ...input, state })
        .pipe(Effect.map((page) => page.items.map((item) => item.number)));

    assert.deepStrictEqual(yield* numbers("merged"), [1]);
    assert.deepStrictEqual(yield* numbers("closed"), [2]);
    assert.deepStrictEqual(yield* numbers("all"), [1, 2]);
    assert.deepStrictEqual(yield* numbers("open"), []);
  }),
);
