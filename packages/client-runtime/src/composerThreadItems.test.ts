import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerThreadTriggerItems,
  type ComposerThreadTriggerCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadTriggerCandidate> = {},
): ComposerThreadTriggerCandidate {
  const base: ComposerThreadTriggerCandidate = {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  };
  return Object.assign(base, overrides);
}

describe("matchComposerThreadTriggerItems", () => {
  const now = Date.parse("2026-10-23T00:00:00.000Z");
  const shells = [
    shell("settled-new", "Model settled", {
      settledOverride: "settled",
      latestUserMessageAt: "2026-10-22T00:00:00.000Z",
    }),
    shell("snoozed", "Model snoozed", {
      snoozedUntil: "2026-10-24T00:00:00.000Z",
      latestUserMessageAt: "2026-10-21T00:00:00.000Z",
    }),
    shell("woke", "Model woke", {
      snoozedUntil: "2026-10-22T00:00:00.000Z",
      latestUserMessageAt: "2026-10-10T00:00:00.000Z",
    }),
    shell("active-old", "Model active old", { latestUserMessageAt: "2026-10-05T00:00:00.000Z" }),
    shell("active-new", "Model active new", { latestUserMessageAt: "2026-10-20T00:00:00.000Z" }),
    shell("unrelated", "Deploy script", { latestUserMessageAt: "2026-10-22T12:00:00.000Z" }),
  ];
  const list = (query: string) =>
    matchComposerThreadTriggerItems({
      shells,
      environmentId,
      linkedEnvironments: new Map(),
      excludeThreadId: null,
      query,
      now,
    });

  it("lists matches active, then snoozed, then settled, newest first in each", () => {
    expect(list("model").map(({ thread, description }) => [thread.threadId, description])).toEqual([
      ["active-new", "Active"],
      ["woke", "Active"],
      ["active-old", "Active"],
      ["snoozed", "Snoozed"],
      ["settled-new", "Settled"],
    ]);
  });

  it("lists every thread for a bare trigger", () => {
    expect(list("").map(({ thread }) => thread.threadId)).toEqual([
      "unrelated",
      "active-new",
      "woke",
      "active-old",
      "snoozed",
      "settled-new",
    ]);
  });
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });

  it("offers machines the composer's environment links to that this client is not paired with", () => {
    expect(
      matchComposerEnvironmentItems({
        environments: [],
        linkedEnvironments: new Map([
          [EnvironmentId.make("env-here"), "Laptop"],
          [EnvironmentId.make("env-build"), "buildbox"],
        ]),
        environmentId: EnvironmentId.make("env-here"),
        query: "build",
      }),
    ).toEqual([
      {
        id: "environment:env-build",
        type: "environment",
        environmentId: "env-build",
        machine: "server",
        label: "buildbox",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map([[EnvironmentId.make("env-vps"), "Hetzner VPS"]]),
        environmentId: EnvironmentId.make("env-here"),
        query: "vps",
      }).map((item) => item.machine),
    ).toEqual(["cloud"]);
  });
});
