import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterFreshThreads,
  resolveSingleScopedEnvironmentId,
  shouldShowThreadListSkeleton,
} from "./thread-list-skeleton-state";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const PROJECT_1 = ProjectId.make("project-1");
const PROJECT_2 = ProjectId.make("project-2");

describe("filterFreshThreads", () => {
  it("drops cached threads from environments that have not synced yet", () => {
    const rows = [
      { id: "t1", environmentId: ENV_A },
      { id: "t2", environmentId: ENV_B },
    ];
    expect(filterFreshThreads(rows, new Set())).toEqual([]);
    expect(filterFreshThreads(rows, new Set())).toBe(filterFreshThreads(rows, new Set()));
    expect(filterFreshThreads(rows, new Set([ENV_A]))).toEqual([rows[0]]);
    expect(filterFreshThreads(rows, new Set([ENV_A, ENV_B]))).toBe(rows);
  });
});

describe("shouldShowThreadListSkeleton", () => {
  it.each([
    {
      name: "shows skeleton while saved environments are still loading on cold start",
      input: {
        isLoadingConnections: true,
        hasConnections: false,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        syncingEnvironmentIds: new Set<EnvironmentId>(),
        hasVisibleRows: false,
      },
      expected: true,
    },
    {
      name: "shows skeleton while an environment is actively connecting or syncing",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_A]),
        hasVisibleRows: false,
      },
      expected: true,
    },
    {
      name: "hides skeleton once fresh rows are available even if another environment still syncs",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_B]),
        hasVisibleRows: true,
      },
      expected: false,
    },
    {
      name: "shows skeleton when filtering specifically to an environment that is still syncing",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: ENV_B,
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_B]),
        hasVisibleRows: false,
      },
      expected: true,
    },
    {
      name: "hides skeleton when filtering to an environment that already finished syncing empty",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: ENV_A,
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_B]),
        hasVisibleRows: false,
      },
      expected: false,
    },
    {
      name: "hides skeleton when all environments have resolved or entered backoff",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        syncingEnvironmentIds: new Set<EnvironmentId>(),
        hasVisibleRows: false,
      },
      expected: false,
    },
    {
      name: "hides skeleton when the device is offline",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "offline" as const,
        selectedEnvironmentId: null,
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_A]),
        hasVisibleRows: false,
      },
      expected: false,
    },
    {
      name: "shows skeleton when a selected project's environment is still syncing and no filtered rows match",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        projectRefs: [{ environmentId: ENV_B, projectId: PROJECT_2 }],
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_B]),
        hasVisibleRows: false,
      },
      expected: true,
    },
    {
      name: "hides skeleton when a selected project belongs only to fresh environments while another environment syncs",
      input: {
        isLoadingConnections: false,
        hasConnections: true,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        projectRefs: [{ environmentId: ENV_A, projectId: PROJECT_1 }],
        syncingEnvironmentIds: new Set<EnvironmentId>([ENV_B]),
        hasVisibleRows: false,
      },
      expected: false,
    },
    {
      name: "hides skeleton when no environments are configured",
      input: {
        isLoadingConnections: false,
        hasConnections: false,
        networkStatus: "online" as const,
        selectedEnvironmentId: null,
        syncingEnvironmentIds: new Set<EnvironmentId>(),
        hasVisibleRows: false,
      },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(shouldShowThreadListSkeleton(input)).toBe(expected);
  });

  it("resolves a single scoped environment id from environment or project filters", () => {
    expect(
      resolveSingleScopedEnvironmentId({
        selectedEnvironmentId: ENV_A,
        projectRefs: [{ environmentId: ENV_B, projectId: PROJECT_2 }],
      }),
    ).toBe(ENV_A);
    expect(
      resolveSingleScopedEnvironmentId({
        selectedEnvironmentId: null,
        projectRefs: [{ environmentId: ENV_B, projectId: PROJECT_2 }],
      }),
    ).toBe(ENV_B);
    expect(
      resolveSingleScopedEnvironmentId({
        selectedEnvironmentId: null,
        projectRefs: [
          { environmentId: ENV_A, projectId: PROJECT_1 },
          { environmentId: ENV_B, projectId: PROJECT_2 },
        ],
      }),
    ).toBeNull();
  });
});
