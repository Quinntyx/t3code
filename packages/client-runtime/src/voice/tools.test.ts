import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { createVoiceTools, type VoiceEnvironmentView } from "./tools.ts";

// Only the read-only tools run here, so the dispatch surface is never reached.
const unusedDispatch = {
  label: "voice:dispatch",
  run: async () => {
    throw new Error("not used");
  },
  permissionAtom: () => ({}) as never,
} as never;

function toolsFor(environments: ReadonlyArray<VoiceEnvironmentView>) {
  return createVoiceTools({
    registry: AtomRegistry.make(),
    dispatch: unusedDispatch,
    environments: () => environments,
    readThread: async () => ({}),
    uuid: () => "generated",
  });
}

type ThreadListing = {
  total: number;
  truncated: boolean;
  needsUser: number;
  byStatus: Record<string, number>;
  threads: ReadonlyArray<Record<string, unknown>>;
};

const environment: VoiceEnvironmentView = {
  id: "env-a",
  label: "Laptop",
  projects: [{ id: "project-a", title: "T3 Code" }],
  providers: [],
  threads: [
    {
      id: "thread-running",
      title: "Voice panel fixes",
      status: "running",
      projectId: "project-a",
      activeRunId: "run-1",
      latestRunStartedAt: "2026-11-17T10:00:00.000Z",
    },
    {
      id: "thread-waiting",
      title: "Land the diff",
      status: "waiting",
      projectId: "project-a",
      pendingRequest: { id: "request-1", kind: "command", blocking: true },
    },
    {
      id: "thread-failed",
      title: "Rewrite indexer",
      status: "failed",
      projectId: "project-a",
      lastError: "The provider exited with code 1.",
      latestRunCompletedAt: "2026-11-17T09:00:00.000Z",
    },
    {
      id: "thread-archived",
      title: "Old spike",
      status: "completed",
      archivedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
};

describe("client Voice tools", () => {
  it("reports thread status, project, environment and what needs the user", async () => {
    const listing = (await toolsFor([environment]).execute("list_threads", {
      environmentId: "env-a",
    })) as ThreadListing;
    expect(listing).toMatchObject({ total: 3, truncated: false, needsUser: 1 });
    expect(listing.threads).toEqual([
      expect.objectContaining({
        threadId: "thread-waiting",
        status: "waiting",
        needsUser: true,
      }),
      expect.objectContaining({
        threadId: "thread-running",
        status: "running",
        needsUser: false,
      }),
      expect.objectContaining({
        threadId: "thread-failed",
        status: "failed",
        needsUser: false,
        lastError: "The provider exited with code 1.",
        lastActiveAt: "2026-11-17T09:00:00.000Z",
      }),
    ]);
    expect(listing.threads[1]).toEqual({
      environmentId: "env-a",
      environment: "Laptop",
      projectId: "project-a",
      project: "T3 Code",
      threadId: "thread-running",
      title: "Voice panel fixes",
      status: "running",
      needsUser: false,
      lastError: null,
      lastActiveAt: "2026-11-17T10:00:00.000Z",
    });
  });

  it("counts a pending non-blocking question as needing the user but not a credential refresh", async () => {
    const awaiting: VoiceEnvironmentView = {
      ...environment,
      threads: [
        {
          id: "thread-question",
          title: "Pick a branch",
          status: "running",
          pendingRequest: { id: "request-q", kind: "user_input", blocking: false },
        },
        {
          id: "thread-refresh",
          title: "Reauthorize",
          status: "running",
          pendingRequest: { id: "request-r", kind: "auth_refresh" },
        },
      ],
    };
    const listing = (await toolsFor([awaiting]).execute("list_threads", {})) as ThreadListing;
    expect(listing.needsUser).toBe(1);
    expect(listing.threads.map((row) => [row.threadId, row.needsUser])).toEqual([
      ["thread-question", true],
      ["thread-refresh", false],
    ]);
  });

  it("reports every match in its counts while bounding the row list", async () => {
    const many: VoiceEnvironmentView = {
      ...environment,
      threads: Array.from({ length: 130 }, (_, index) => ({
        id: `thread-${index}`,
        title: `Task ${index}`,
        status: index % 2 === 0 ? "running" : "completed",
        ...(index < 5
          ? { pendingRequest: { id: `request-${index}`, kind: "command", blocking: true } }
          : {}),
      })),
    };
    const listing = (await toolsFor([many]).execute("list_threads", {})) as ThreadListing;
    expect(listing.total).toBe(130);
    expect(listing.truncated).toBe(true);
    expect(listing.needsUser).toBe(5);
    expect(listing.byStatus).toEqual({ running: 65, completed: 65 });
    expect(listing.threads).toHaveLength(100);
    // Five need the user, then the sixty-two remaining running threads, then settled ones.
    expect(listing.threads.slice(0, 5).every((row) => row.needsUser === true)).toBe(true);
    expect(listing.threads.slice(5, 67).every((row) => row.status === "running")).toBe(true);
    expect(listing.threads.slice(67).every((row) => row.status === "completed")).toBe(true);
  });

  it("keeps archived threads out of the working set unless the user searches for them", async () => {
    const tools = toolsFor([environment]);
    const listed = (await tools.execute("list_threads", {
      environmentId: "env-a",
    })) as ThreadListing;
    expect(listed.threads.map((row) => row.threadId)).not.toContain("thread-archived");
    const searched = (await tools.execute("list_threads", {
      environmentId: "env-a",
      query: "spike",
    })) as ThreadListing;
    expect(searched.threads.map((row) => row.threadId)).toEqual(["thread-archived"]);
  });

  it("lists only the environments this client can see", async () => {
    await expect(
      toolsFor([environment]).execute("list_threads", { environmentId: "env-b" }),
    ).rejects.toThrow("not visible");
  });
});
