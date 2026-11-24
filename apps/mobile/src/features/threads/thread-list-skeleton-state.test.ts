import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterFreshThreads, shouldShowThreadListSkeleton } from "./thread-list-skeleton-state";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

describe("filterFreshThreads", () => {
  it("drops cached threads from environments that have not synced yet", () => {
    const rows = [
      { id: "t1", environmentId: ENV_A },
      { id: "t2", environmentId: ENV_B },
    ];
    expect(filterFreshThreads(rows, new Set())).toEqual([]);
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
});
