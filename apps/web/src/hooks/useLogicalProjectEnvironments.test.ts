import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useLogicalProjectEnvironments } from "./useLogicalProjectEnvironments";

const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  mode: "repository" as "repository" | "separate",
}));

vi.mock("../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["source", "target"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      serverConfig: null,
    })),
  }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("source"),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: state.mode,
    sidebarProjectGroupingOverrides: {},
  }),
}));

function project(environment: string, root: string, workspaceRoot = root): EnvironmentProject {
  return {
    id: ProjectId.make(`${environment}:${workspaceRoot}`),
    environmentId: EnvironmentId.make(environment),
    title: "Repository",
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: "github.com/org/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/org/repo.git",
      },
      rootPath: root,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-31T00:00:00Z",
    updatedAt: "2026-10-31T00:00:00Z",
  };
}

describe("machine handoff environments", () => {
  it.each(["repository", "separate"] as const)(
    "finds destination roots independently of %s sidebar grouping without changing drafts",
    (mode) => {
      state.mode = mode;
      const source = project("source", "/repo/main");
      const subdirectory = project("target", "/work/repo/main", "/work/repo/main/apps/web");
      const destination = project("target", "/work/repo/main");
      state.projects = [source, subdirectory, destination];

      expect(
        useLogicalProjectEnvironments(source, false, { machineHandoff: true }).map(
          (option) => option.projectId,
        ),
      ).toEqual([source.id, destination.id]);
      expect(
        useLogicalProjectEnvironments(source, false).map((option) => option.projectId),
      ).toEqual(mode === "separate" ? [source.id] : [source.id, subdirectory.id]);
    },
  );
});
