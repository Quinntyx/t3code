import { describe, expect, it } from "vite-plus/test";

import {
  BUDDY_REST_AFTER_MS,
  buddyRunOutcome,
  deriveBuddyLoop,
  deriveBuddyRest,
  restLoop,
  restTransition,
  type BuddyRunSnapshot,
} from "./buddy.logic";

type Shell = NonNullable<Parameters<typeof deriveBuddyLoop>[0]>;
type Items = Parameters<typeof deriveBuddyLoop>[1];

function shell(overrides: Partial<Shell> = {}, status = "running", activeRunId = "run-2"): Shell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: { status, activeRunId } as Shell["runtime"],
    ...overrides,
  };
}

const item = (type: Items[number]["type"], runId: string | null = "run-2") =>
  ({ type, runId }) as Items[number];

describe("deriveBuddyLoop", () => {
  it.each([
    ["no thread", null, [], "idle"],
    ["a stopped thread", shell({}, "idle"), [item("command_execution")], "idle"],
    ["a run with no items yet", shell(), [item("assistant_message", "run-1")], "thinking"],
    ["streaming text", shell(), [item("command_execution"), item("assistant_message")], "thinking"],
    ["a tool call", shell(), [item("reasoning"), item("command_execution")], "working"],
    [
      "a finished tool before an unscoped notice",
      shell(),
      [item("file_change"), item("system_notice", null)],
      "working",
    ],
    ["an approval", shell({ hasPendingApprovals: true }), [item("command_execution")], "waiting"],
    ["a question while stopped", shell({ hasPendingUserInput: true }, "idle"), [], "waiting"],
    ["one subagent", shell(), [item("command_execution"), item("subagent")], "juggling"],
    [
      "two subagents",
      shell(),
      [item("command_execution"), item("subagent"), item("subagent")],
      "juggling2",
    ],
    ["a compaction", shell(), [item("compaction")], "sweeping"],
    ["a checkpoint", shell(), [item("command_execution"), item("checkpoint")], "carrying"],
  ] as const)("shows %s as %s", (_name, input, items, expected) => {
    expect(deriveBuddyLoop(input, items)).toBe(expected);
  });

  it.each([
    [1, "working"],
    [2, "working2"],
    [3, "working3"],
  ] as const)("uses the %i-session clip while tools run", (count, expected) => {
    expect(deriveBuddyLoop(shell(), [item("command_execution")], count)).toBe(expected);
  });
});

describe("deriveBuddyRest", () => {
  it.each([
    [0, "awake"],
    [BUDDY_REST_AFTER_MS.restless - 1, "awake"],
    [BUDDY_REST_AFTER_MS.restless, "restless"],
    [BUDDY_REST_AFTER_MS.dozing, "dozing"],
    [BUDDY_REST_AFTER_MS.sleeping, "sleeping"],
    [BUDDY_REST_AFTER_MS.sleeping * 10, "sleeping"],
  ] as const)("is %s after %ims", (idleForMs, expected) => {
    expect(deriveBuddyRest(idleForMs)).toBe(expected);
  });

  it.each([
    ["awake", "idle"],
    ["restless", "roam"],
    ["dozing", "dozing"],
    ["sleeping", "sleeping"],
  ] as const)("loops %s on %s", (rest, expected) => {
    expect(restLoop(rest)).toBe(expected);
  });

  it.each([
    ["awake", "restless", "yawning"],
    ["restless", "dozing", null],
    ["dozing", "sleeping", "collapsing"],
    ["sleeping", "awake", "waking"],
    ["dozing", "dozing", null],
  ] as const)("transitions %s to %s with %s", (from, to, expected) => {
    expect(restTransition(from, to)).toBe(expected);
  });
});

describe("buddyRunOutcome", () => {
  const run = (status: string, runId = "run-1", threadKey = "env:thread"): BuddyRunSnapshot => ({
    threadKey,
    runId,
    status,
  });

  it.each([
    ["a run completing", run("running"), run("completed"), "success"],
    ["a run failing", run("waiting"), run("failed"), "error"],
    ["an interrupted run", run("running"), run("interrupted"), null],
    ["opening a thread that already finished", null, run("completed"), null],
    [
      "switching to a finished thread",
      run("running"),
      run("completed", "run-1", "env:other"),
      null,
    ],
    ["a new run replacing the watched one", run("running"), run("completed", "run-2"), null],
  ] as const)("reacts to %s", (_name, previous, next, expected) => {
    expect(buddyRunOutcome(previous, next)).toBe(expected);
  });
});
