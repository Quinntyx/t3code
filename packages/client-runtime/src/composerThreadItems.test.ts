import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
  matchComposerThreadTriggerItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
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
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", { environmentId: vps }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    { thread: { environmentId, threadId: "here" }, label: "Deploy script", description: "Thread" },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Thread on Hetzner VPS",
    },
  ]);
});

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
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });
});
