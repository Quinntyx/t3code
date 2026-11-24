import {
  EnvironmentId,
  ProjectId,
  SCRATCH_KEY_MAX_CHARS,
  ScratchKey,
  SourceControlProviderKind,
  type ScratchSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { deriveScratchKey, resolveScratchOwnerEnvironment } from "./scratchKey.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const third = EnvironmentId.make("third");

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: SourceControlProviderKind.make("github"),
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId: local,
    id: ProjectId.make("project"),
    title: "project",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function summary(
  scratchKey: ScratchKey,
  updatedAt: string,
  hasContent = true,
  revision = hasContent ? 1 : 0,
): ScratchSummary {
  return { scratchKey, revision, updatedAt, hasContent };
}

describe("deriveScratchKey", () => {
  it("keys a scratch project by machine so two machines never share a draft", () => {
    const localKey = deriveScratchKey(
      makeProject("/tmp/scratch", { isScratch: true, repositoryIdentity: null }),
    );
    const remoteKey = deriveScratchKey(
      makeProject("/tmp/scratch", {
        environmentId: remote,
        isScratch: true,
        repositoryIdentity: null,
      }),
    );

    expect(localKey).toBe("no-project:local");
    expect(remoteKey).toBe("no-project:remote");
    expect(localKey).not.toContain("\0");
  });

  it("keys a cloned repository the same on every machine", () => {
    const localKey = deriveScratchKey(
      makeProject("/home/me/src/t3code", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/home/me/src/t3code" },
      }),
    );
    const remoteKey = deriveScratchKey(
      makeProject("/Users/me/t3code", {
        environmentId: remote,
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/Users/me/t3code" },
      }),
    );

    expect(localKey).toBe("repo:github.com/t3tools/t3code");
    expect(remoteKey).toBe(localKey);
  });

  it("keeps monorepo folders apart with a repository-relative path", () => {
    const app = deriveScratchKey(
      makeProject("/work/t3code/apps/web", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/t3code" },
      }),
    );
    const server = deriveScratchKey(
      makeProject("/elsewhere/t3code/apps/server", {
        environmentId: remote,
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/elsewhere/t3code" },
      }),
    );

    expect(app).toBe("repo:github.com/t3tools/t3code::apps/web");
    expect(server).toBe("repo:github.com/t3tools/t3code::apps/server");
  });

  it("falls back to the canonical key when the checkout is outside the repository root", () => {
    expect(
      deriveScratchKey(
        makeProject("/unrelated/folder", {
          repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/t3code" },
        }),
      ),
    ).toBe("repo:github.com/t3tools/t3code");
  });

  it("keys a folder without repository identity by machine and path", () => {
    expect(deriveScratchKey(makeProject("/plain/folder/", { repositoryIdentity: null }))).toBe(
      "path:local:/plain/folder",
    );
    expect(
      deriveScratchKey(
        makeProject("/plain/folder", { environmentId: remote, repositoryIdentity: null }),
      ),
    ).toBe("path:remote:/plain/folder");
  });

  it("never emits a NUL from a repository identity", () => {
    const key = deriveScratchKey(
      makeProject("/plain/folder", {
        repositoryIdentity: { ...repositoryIdentity, canonicalKey: "bad\0key" },
      }),
    );

    expect(key).toBe("path:local:/plain/folder");
  });
});

describe("resolveScratchOwnerEnvironment", () => {
  const scratchKey = ScratchKey.make("repo:github.com/t3tools/t3code");

  const resolve = (input: {
    readonly scratchKey?: ScratchKey;
    readonly memberEnvironmentIds: ReadonlyArray<EnvironmentId>;
    readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
    readonly summaries?: ReadonlyMap<EnvironmentId, ReadonlyMap<ScratchKey, ScratchSummary>>;
    readonly establishedOwner?: {
      readonly environmentId: EnvironmentId;
      readonly revision: number;
    };
  }) =>
    resolveScratchOwnerEnvironment({
      scratchKey: input.scratchKey ?? scratchKey,
      memberEnvironmentIds: input.memberEnvironmentIds,
      connectedEnvironmentIds: new Set(input.connectedEnvironmentIds),
      summariesByEnvironmentId: input.summaries ?? new Map(),
      ...(input.establishedOwner === undefined ? {} : { establishedOwner: input.establishedOwner }),
    });

  it("has no owner without member machines", () => {
    expect(resolve({ memberEnvironmentIds: [], connectedEnvironmentIds: [] })).toBeNull();
  });

  it("uses the only member machine", () => {
    expect(resolve({ memberEnvironmentIds: [remote], connectedEnvironmentIds: [remote] })).toBe(
      remote,
    );
  });

  it("keeps a no-project document on the machine named by its key", () => {
    expect(
      resolve({
        scratchKey: ScratchKey.make("no-project:remote"),
        memberEnvironmentIds: [local, remote, third],
        connectedEnvironmentIds: [local, remote],
      }),
    ).toBe(remote);
    expect(
      resolve({
        scratchKey: ScratchKey.make("no-project:third"),
        memberEnvironmentIds: [local, remote],
        connectedEnvironmentIds: [local, remote],
      }),
    ).toBe(local);
    const colonEnv = "env:remote:1" as EnvironmentId;
    expect(
      resolve({
        scratchKey: ScratchKey.make("path:env:remote:1:/plain/folder"),
        memberEnvironmentIds: [local, colonEnv],
        connectedEnvironmentIds: [local, colonEnv],
      }),
    ).toBe(colonEnv);
    // Cold-start offline guard: an established owner stays authoritative even if missing from live members.
    expect(
      resolve({
        memberEnvironmentIds: [remote],
        connectedEnvironmentIds: [remote],
        establishedOwner: { environmentId: local, revision: 3 },
      }),
    ).toBe(local);
  });

  it("prefers the connected machine holding the newest content", () => {
    const summaries = new Map([
      [local, new Map([[scratchKey, summary(scratchKey, "2026-07-02T00:00:00.000Z")]])],
      [remote, new Map([[scratchKey, summary(scratchKey, "2026-07-01T00:00:00.000Z")]])],
    ]);

    expect(
      resolve({
        memberEnvironmentIds: [local, remote],
        connectedEnvironmentIds: [local, remote],
        summaries,
      }),
    ).toBe(local);
    expect(
      resolve({
        memberEnvironmentIds: [local, remote],
        connectedEnvironmentIds: [local, remote],
        summaries: new Map([
          [local, new Map([[scratchKey, summary(scratchKey, "2026-07-01T00:00:00.000Z")]])],
          [remote, new Map([[scratchKey, summary(scratchKey, "2026-07-03T00:00:00.000Z")]])],
        ]),
      }),
    ).toBe(remote);
  });

  it("prefers higher revision even when the newer document was cleared, preventing stale resurrection", () => {
    const summaries = new Map([
      [local, new Map([[scratchKey, summary(scratchKey, "2026-07-05T00:00:00.000Z", false, 5)]])],
      [remote, new Map([[scratchKey, summary(scratchKey, "2026-07-01T00:00:00.000Z", true, 1)]])],
    ]);

    expect(
      resolve({
        memberEnvironmentIds: [local, remote],
        connectedEnvironmentIds: [local, remote],
        summaries,
      }),
    ).toBe(local);
  });

  it("ignores untouched revision-0 empty documents", () => {
    const summaries = new Map([
      [local, new Map([[scratchKey, summary(scratchKey, "2026-07-05T00:00:00.000Z", false, 0)]])],
      [remote, new Map([[scratchKey, summary(scratchKey, "2026-07-01T00:00:00.000Z", true, 1)]])],
    ]);

    expect(
      resolve({
        memberEnvironmentIds: [local, remote],
        connectedEnvironmentIds: [local, remote],
        summaries,
      }),
    ).toBe(remote);
  });

  it("bounds very long workspace paths to SCRATCH_KEY_MAX_CHARS deterministically", () => {
    const longPath = `/${"nested-segment/".repeat(60)}project`;
    const first = deriveScratchKey(makeProject(longPath, { repositoryIdentity: null }));
    const second = deriveScratchKey(makeProject(longPath, { repositoryIdentity: null }));
    const other = deriveScratchKey(makeProject(`${longPath}-other`, { repositoryIdentity: null }));
    expect(first.length).toBeLessThanOrEqual(SCRATCH_KEY_MAX_CHARS);
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it("falls back to the smallest environment id when every document is empty", () => {
    const summaries = new Map([
      [remote, new Map([[scratchKey, summary(scratchKey, "2026-07-05T00:00:00.000Z", false)]])],
    ]);

    expect(
      resolve({
        memberEnvironmentIds: [remote, local],
        connectedEnvironmentIds: [remote, local],
        summaries,
      }),
    ).toBe(local);
  });

  it("breaks a timestamp tie by environment id", () => {
    const updatedAt = "2026-07-01T00:00:00.000Z";
    const summaries = new Map([
      [third, new Map([[scratchKey, summary(scratchKey, updatedAt)]])],
      [remote, new Map([[scratchKey, summary(scratchKey, updatedAt)]])],
    ]);

    expect(
      resolve({
        memberEnvironmentIds: [third, remote],
        connectedEnvironmentIds: [third, remote],
        summaries,
      }),
    ).toBe(remote);
  });

  it("falls back to offline members when nothing is connected", () => {
    expect(resolve({ memberEnvironmentIds: [third, remote], connectedEnvironmentIds: [] })).toBe(
      remote,
    );
  });

  it("keeps an established owner authoritative across disconnects instead of failing over to a stale peer", () => {
    const summaries = new Map([
      [local, new Map([[scratchKey, summary(scratchKey, "2026-07-05T00:00:00.000Z", true, 1)]])],
    ]);
    expect(
      resolveScratchOwnerEnvironment({
        scratchKey,
        memberEnvironmentIds: [local, remote],
        connectedEnvironmentIds: new Set([local]),
        summariesByEnvironmentId: summaries,
        establishedOwner: { environmentId: remote, revision: 12 },
      }),
    ).toBe(remote);
  });
});
