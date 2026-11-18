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
    const rows = (await toolsFor([environment]).execute("list_threads", {
      environmentId: "env-a",
    })) as ReadonlyArray<Record<string, unknown>>;
    expect(rows).toEqual([
      {
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
      },
      expect.objectContaining({
        threadId: "thread-waiting",
        status: "waiting",
        needsUser: true,
      }),
      expect.objectContaining({
        threadId: "thread-failed",
        status: "failed",
        needsUser: false,
        lastError: "The provider exited with code 1.",
        lastActiveAt: "2026-11-17T09:00:00.000Z",
      }),
    ]);
  });

  it("keeps archived threads out of the working set unless the user searches for them", async () => {
    const tools = toolsFor([environment]);
    const listed = (await tools.execute("list_threads", {
      environmentId: "env-a",
    })) as ReadonlyArray<Record<string, unknown>>;
    expect(listed.map((row) => row.threadId)).not.toContain("thread-archived");
    const searched = (await tools.execute("list_threads", {
      environmentId: "env-a",
      query: "spike",
    })) as ReadonlyArray<Record<string, unknown>>;
    expect(searched.map((row) => row.threadId)).toEqual(["thread-archived"]);
  });

  it("lists only the environments this client can see", async () => {
    await expect(
      toolsFor([environment]).execute("list_threads", { environmentId: "env-b" }),
    ).rejects.toThrow("not visible");
  });
});
