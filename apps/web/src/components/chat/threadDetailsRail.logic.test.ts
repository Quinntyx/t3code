import { expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { buildRailRows, buildRailSideChats } from "./threadDetailsRail.logic";

const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
const at = (minutesAgo: number) =>
  DateTime.makeUnsafe(AT.pipe(DateTime.subtract({ minutes: minutesAgo })));

const agent = (
  id: string,
  title: string,
  startedMinutesAgo: number,
  extra: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent =>
  ({
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-main"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make(`${id}-parent`),
    origin: "app_owned",
    createdBy: "agent",
    driver: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`${id}-thread`),
    nativeTaskRef: null,
    prompt: title,
    title,
    model: null,
    status: "running",
    result: null,
    startedAt: at(startedMinutesAgo),
    completedAt: null,
    updatedAt: at(startedMinutesAgo),
    ...extra,
  }) as OrchestrationV2Subagent;

const workflow = (
  id: string,
  name: string,
  startedMinutesAgo: number,
  phases: ReadonlyArray<{
    title: string;
    members: ReadonlyArray<{ label: string; state: "running" | "completed" }>;
  }>,
): OrchestrationV2Subagent =>
  agent(id, name, startedMinutesAgo, {
    workflow: {
      name,
      phases: phases.map((phase, index) => ({ index, title: phase.title })),
      agents: phases.flatMap((phase, phaseIndex) =>
        phase.members.map((member, memberIndex) => ({
          index: phaseIndex * 10 + memberIndex,
          label: member.label,
          state: member.state,
          phaseIndex,
          phaseTitle: phase.title,
          startedAt: DateTime.toEpochMillis(at(startedMinutesAgo)),
        })),
      ),
    },
  });

const projectionOf = (subagents: ReadonlyArray<OrchestrationV2Subagent>) =>
  ({ subagents }) as never;

it("lists active agents newest first", () => {
  const rows = buildRailRows(
    projectionOf([agent("slow", "Slow", 9), agent("fast", "Fast", 2), agent("mid", "Mid", 5)]),
  );
  expect(rows.map((row) => row.title)).toEqual(["Fast", "Mid", "Slow"]);
});

it("leaves finished agents and parents off the rail", () => {
  const rows = buildRailRows(
    projectionOf([
      agent("done", "Done", 1, { status: "completed" }),
      agent("live", "Live", 2),
      agent("queued", "Queued", 3, { status: "pending", startedAt: null }),
    ]),
  );
  expect(rows.map((row) => row.title)).toEqual(["Live", "Queued"]);
});

it("keeps a workflow's members together and splits its stages with dividers", () => {
  const rows = buildRailRows(
    projectionOf([
      agent("newest", "Newest", 1),
      workflow("wf", "review-changes", 3, [
        { title: "Explore", members: [{ label: "Map", state: "completed" }] },
        {
          title: "Review",
          members: [
            { label: "Correctness", state: "running" },
            { label: "Styles", state: "running" },
          ],
        },
      ]),
      agent("oldest", "Oldest", 9),
    ]),
  );
  expect(rows.map((row) => row.title)).toEqual(["Newest", "Correctness", "Styles", "Oldest"]);
  // The workflow opens at its running stage; its exit divider names the workflow alone.
  expect(rows.map((row) => row.divider)).toEqual([
    null,
    "review-changes · Review",
    null,
    "review-changes",
  ]);
  expect(rows[1]).toMatchObject({ kind: "agent", workflowName: "review-changes" });
});

it("attributes a workflow member's icon to the coordinator's provider", () => {
  const rows = buildRailRows(
    projectionOf([
      workflow("wf", "review-changes", 1, [
        { title: "Review", members: [{ label: "Correctness", state: "running" }] },
      ]),
    ]),
  );
  expect(rows[0]?.providerInstanceId).toBe("claudeAgent");
});

it("puts remote agents after the local ones", () => {
  const rows = buildRailRows(
    projectionOf([
      agent("local", "Local", 2),
      agent("remote", "Bisect", 1, {
        childThreadId: null,
        remoteChild: {
          environmentId: "environment-schooner" as never,
          threadId: ThreadId.make("thread-bisect"),
          label: "schooner",
        },
      }),
    ]),
  );
  expect(rows.map((row) => row.kind)).toEqual(["agent", "remote"]);
  expect(rows[1]).toMatchObject({ title: "Bisect", environmentLabel: "schooner" });
});

it("lists side chats and hides ones hidden everywhere", () => {
  const shell = (id: string, title: string) =>
    ({
      id: ThreadId.make(id),
      title,
      lineage: {
        rootThreadId: ThreadId.make("thread-main"),
        parentThreadId: ThreadId.make("thread-main"),
        relationshipToParent: null,
        sideChat: true,
      },
      status: "idle",
      activityRunStatus: null,
    }) as never;
  const sideChats = buildRailSideChats({
    threadId: ThreadId.make("thread-main"),
    projection: null,
    shells: [shell("side-a", "Why layers drop"), shell("side-b", "Safari timeline")],
    isHidden: (id) => id === "side-b",
  });
  expect(sideChats.map((chat) => chat.title)).toEqual(["Why layers drop"]);
});
