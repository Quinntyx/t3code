import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
  type ThreadStructureTurnItem,
} from "@t3tools/client-runtime/state/shell";

export type BuddyLoop = "idle" | "thinking" | "working" | "waiting";
export type BuddyOneShot = "success" | "error" | "angry";
export type BuddyAnimation = BuddyLoop | BuddyOneShot;

export const BUDDY_ANIMATIONS: ReadonlyArray<BuddyAnimation> = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "success",
  "error",
  "angry",
];

export function isBuddyOneShot(animation: BuddyAnimation): animation is BuddyOneShot {
  return animation === "success" || animation === "error" || animation === "angry";
}

type BuddyShell = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
>;

/** What the agent on the thread is doing, as one of the buddy's looping animations. */
export function deriveBuddyLoop(
  shell: BuddyShell | null,
  turnItems: ReadonlyArray<Pick<ThreadStructureTurnItem, "type" | "runId">>,
): BuddyLoop {
  if (shell === null) return "idle";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.pendingSubagentRequest) {
    return "waiting";
  }
  if (!threadRuntimeIsActive(shell.runtime)) return "idle";
  const runId = shell.runtime?.activeRunId ?? null;
  if (runId === null) return "thinking";
  // A run's items are appended, so its newest activity is at the tail.
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.runId === null) continue;
    if (item.runId !== runId) break;
    switch (item.type) {
      case "command_execution":
      case "file_change":
      case "file_search":
      case "web_search":
      case "dynamic_tool":
      case "subagent":
        return "working";
      case "reasoning":
      case "assistant_message":
      case "proposed_plan":
      case "user_message":
        return "thinking";
    }
  }
  return "thinking";
}

export interface BuddyRunSnapshot {
  readonly threadKey: string;
  readonly runId: string;
  readonly status: string;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The reaction to a run that finished while the buddy watched it. */
export function buddyRunOutcome(
  previous: BuddyRunSnapshot | null,
  next: BuddyRunSnapshot | null,
): BuddyOneShot | null {
  if (
    previous === null ||
    next === null ||
    previous.threadKey !== next.threadKey ||
    previous.runId !== next.runId ||
    !ACTIVE_RUN_STATUSES.has(previous.status)
  ) {
    return null;
  }
  if (next.status === "completed") return "success";
  if (next.status === "failed") return "error";
  return null;
}

/** Placement as a fraction of the space the buddy can move in, so it stays on screen. */
export interface BuddyPosition {
  readonly x: number;
  readonly y: number;
}

export function clampBuddyFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
