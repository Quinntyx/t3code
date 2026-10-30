import {
  ContextHandoffId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  matchingMachineHandoffProjects,
  machineHandoffBlocker,
  relayMachineHandoff,
  sourceProjectSubdirectory,
  resolveHandoffEndpoints,
  resolvePendingHandoff,
  type HandoffTimelineRun,
} from "./handoff.ts";

describe("machine handoff project matching", () => {
  const project = (
    environment: string,
    root: string,
    workspaceRoot = root,
    canonicalKey = "github.com/org/repo",
  ) => ({
    id: ProjectId.make(`${environment}:${workspaceRoot}`),
    environmentId: EnvironmentId.make(environment),
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey,
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://${canonicalKey}`,
      },
      rootPath: root,
    },
  });

  it("matches repository and project-relative folder, not machine-local absolute paths or titles", () => {
    const source = project("source", "/home/me/repo", "/home/me/repo/apps/web");
    const matching = project("target", "C:\\work\\repo", "C:\\work\\repo\\apps\\web");
    expect(
      matchingMachineHandoffProjects(source, [
        source,
        project("target", "/work/repo"),
        project("target", "/work/repo", "/work/repo/apps/mobile"),
        project("target", "/work/another", "/work/another/apps/web", "github.com/org/other"),
        matching,
      ]),
    ).toEqual([matching]);
  });

  it("does not guess matches for an unidentified repository or ambiguous root", () => {
    const source = project("source", "/repo");
    expect(
      matchingMachineHandoffProjects({ ...source, repositoryIdentity: null }, [
        project("target", "/repo"),
      ]),
    ).toEqual([]);
    expect(
      matchingMachineHandoffProjects(project("source", "/repo", "/repo-other"), [
        project("target", "/repo"),
      ]),
    ).toEqual([]);
  });
});

describe("machine handoff relay", () => {
  const ready = {
    sourceAvailable: true,
    sourceStatus: "completed",
    sourceConnected: true,
    targetConnected: true,
    sourceSupported: true,
    targetSupported: true,
    canExport: true,
    canImport: true,
    projectSelected: true,
    modelReady: true,
  };

  it("refuses active sources, unavailable machines, permissions and missing destinations", () => {
    expect(machineHandoffBlocker(ready)).toBeNull();
    for (const sourceStatus of ["preparing", "queued", "starting", "running", "waiting"]) {
      expect(machineHandoffBlocker({ ...ready, sourceStatus })).toContain("Stop");
    }
    for (const key of [
      "sourceAvailable",
      "sourceConnected",
      "targetConnected",
      "sourceSupported",
      "targetSupported",
      "canExport",
      "canImport",
      "projectSelected",
      "modelReady",
    ] as const) {
      expect(machineHandoffBlocker({ ...ready, [key]: false })).not.toBeNull();
    }
  });

  it("relays the opaque snapshot unchanged and rechecks eligibility before importing", async () => {
    const snapshot = { opaque: "do not inspect" };
    const importSnapshot = vi.fn(async (value: typeof snapshot) => value);
    const eligibility = vi
      .fn<() => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValue("Permission revoked");
    await expect(
      relayMachineHandoff({ eligibility, exportSnapshot: async () => snapshot, importSnapshot }),
    ).rejects.toThrow("Permission revoked");
    expect(importSnapshot).not.toHaveBeenCalled();
    await expect(
      relayMachineHandoff({
        eligibility: () => null,
        exportSnapshot: async () => snapshot,
        importSnapshot,
      }),
    ).resolves.toBe(snapshot);
    expect(importSnapshot.mock.calls[0]?.[0]).toBe(snapshot);
  });

  it("does not export a blocked source or import after a failed export", async () => {
    const exportSnapshot = vi.fn(async () => {
      throw new Error("Export rejected");
    });
    const importSnapshot = vi.fn(async () => undefined);
    await expect(
      relayMachineHandoff({
        eligibility: () => "Source is active",
        exportSnapshot,
        importSnapshot,
      }),
    ).rejects.toThrow("Source is active");
    expect(exportSnapshot).not.toHaveBeenCalled();
    await expect(
      relayMachineHandoff({ eligibility: () => null, exportSnapshot, importSnapshot }),
    ).rejects.toThrow("Export rejected");
    expect(importSnapshot).not.toHaveBeenCalled();
  });

  it("preserves repository-relative project paths without accepting sibling prefixes", () => {
    expect(sourceProjectSubdirectory("/repo", "/repo/apps/mobile")).toBe("apps/mobile");
    expect(sourceProjectSubdirectory("C:\\repo\\", "C:\\repo\\apps\\mobile")).toBe("apps/mobile");
    expect(sourceProjectSubdirectory("/repo/", "/repo")).toBe("");
    expect(sourceProjectSubdirectory("/repo", "/repository/other")).toBeNull();
    expect(sourceProjectSubdirectory(undefined, "/repo/apps/mobile")).toBeNull();
    expect(sourceProjectSubdirectory("/repo", "/repo/../elsewhere")).toBeNull();
    expect(sourceProjectSubdirectory("", "/repo/apps/mobile")).toBeNull();
  });
});

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const projection = {
  runs: [
    {
      ...run("source", 1, from, "source"),
      status: "completed",
      contextHandoffId: null,
      startedAt: "2026-10-11T00:00:00Z",
    },
  ],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("removes the preview while the handoff starts", () => {
    const selection = { instanceId: to, model: "destination" };
    const providers = [{ instanceId: from }] as unknown as ServerProvider[];
    const starting = {
      ...projection,
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          ...run("target", 2, to, "destination"),
          status: "starting" as const,
          startedAt: null,
          contextHandoffId: ContextHandoffId.make("handoff"),
        },
      ],
    };

    expect(resolvePendingHandoff(projection, selection, providers)).not.toBeNull();
    expect(resolvePendingHandoff(starting, selection, providers)).toBeNull();
    expect(
      resolvePendingHandoff(starting, { instanceId: from, model: "source" }, providers),
    ).toEqual({
      from: [selection],
      to: { instanceId: from, model: "source" },
    });
  });

  it.each(["preparing", "queued", "failed", "cancelled", "rolled_back"] as const)(
    "keeps the preview when an unstarted handoff run is %s",
    (status) => {
      const selection = { instanceId: to, model: "destination" };
      const unstarted = {
        ...projection,
        runs: [
          ...projection.runs,
          {
            ...projection.runs[0]!,
            ...run("target", 2, to, "destination"),
            status,
            startedAt: null,
            contextHandoffId: ContextHandoffId.make("handoff"),
          },
        ],
      };

      expect(resolvePendingHandoff(unstarted, selection, [])).toEqual({
        from: [{ instanceId: from, model: "source" }],
        to: selection,
      });
    },
  );

  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });
  it("stays hidden while the thread's timeline is empty", () => {
    const empty = { ...projection, visibleTurnItems: [] };
    expect(resolvePendingHandoff(empty, { instanceId: to, model: "first" }, [])).toBeNull();
    // Paging can leave a window of only tool rows after the prompt.
    const toolRowsOnly = {
      ...projection,
      visibleTurnItems: [{ item: { type: "command_execution" } }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(toolRowsOnly, { instanceId: to, model: "first" }, [])?.to.model,
    ).toBe("first");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers),
    ).toBeNull();
  });
});
