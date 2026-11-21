import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
  type ThreadStructureTurnItem,
} from "@t3tools/client-runtime/state/shell";

export type BuddyLoop =
  | "idle"
  | "roam"
  | "thinking"
  | "working"
  | "working2"
  | "working3"
  | "juggling"
  | "juggling2"
  | "waiting"
  | "sweeping"
  | "carrying"
  | "dozing"
  | "sleeping"
  | "drag";

/** Transitions play once and hand control back to the loop that follows them. */
export type BuddyOneShot = "yawning" | "collapsing" | "waking" | "success" | "error" | "angry";
export type BuddyAnimation = BuddyLoop | BuddyOneShot;

export const BUDDY_ANIMATIONS: ReadonlyArray<BuddyAnimation> = [
  "idle",
  "roam",
  "thinking",
  "working",
  "working2",
  "working3",
  "juggling",
  "juggling2",
  "waiting",
  "sweeping",
  "carrying",
  "dozing",
  "sleeping",
  "yawning",
  "collapsing",
  "waking",
  "success",
  "error",
  "angry",
  "drag",
];

/** How long the buddy waits before each stage of the doze-off sequence. */
export const BUDDY_REST_AFTER_MS = { restless: 25_000, dozing: 70_000, sleeping: 150_000 };

export function isBuddyOneShot(animation: BuddyAnimation): animation is BuddyOneShot {
  return (
    animation === "yawning" ||
    animation === "collapsing" ||
    animation === "waking" ||
    animation === "success" ||
    animation === "error" ||
    animation === "angry"
  );
}

/** Idle stages, oldest first: the buddy drifts from awake to asleep as the app sits untouched. */
export type BuddyRest = "awake" | "restless" | "dozing" | "sleeping";

export function deriveBuddyRest(idleForMs: number): BuddyRest {
  if (idleForMs >= BUDDY_REST_AFTER_MS.sleeping) return "sleeping";
  if (idleForMs >= BUDDY_REST_AFTER_MS.dozing) return "dozing";
  if (idleForMs >= BUDDY_REST_AFTER_MS.restless) return "restless";
  return "awake";
}

/** The looping clip for a stage of the doze-off sequence. */
export function restLoop(rest: BuddyRest): BuddyLoop {
  switch (rest) {
    case "restless":
      return "roam";
    case "dozing":
      return "dozing";
    case "sleeping":
      return "sleeping";
    case "awake":
      return "idle";
  }
}

/** The transition clip played when the buddy enters `to` from a shallower stage. */
export function restTransition(from: BuddyRest, to: BuddyRest): BuddyOneShot | null {
  if (from === to) return null;
  if (to === "awake") return "waking";
  // Deepening rest reads as a yawn, then a slump, then nothing more.
  if (from === "awake") return "yawning";
  if (to === "sleeping") return "collapsing";
  return null;
}

type BuddyShell = Pick<
  EnvironmentThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
>;

/**
 * What the agent on the thread is doing, as one of the buddy's looping animations.
 * `activeThreadCount` is how many threads the environment is running at once, which
 * the source theme uses to pick busier clips for 2 and 3+ concurrent sessions.
 */
export function deriveBuddyLoop(
  shell: BuddyShell | null,
  turnItems: ReadonlyArray<Pick<ThreadStructureTurnItem, "type" | "runId">>,
  activeThreadCount = 1,
): BuddyLoop {
  if (shell === null) return "idle";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput || shell.pendingSubagentRequest) {
    return "waiting";
  }
  if (!threadRuntimeIsActive(shell.runtime)) return "idle";
  const runId = shell.runtime?.activeRunId ?? null;
  if (runId === null) return "thinking";

  // A run's items are appended, so its newest activity is at the tail.
  let subagents = 0;
  let newest: ThreadStructureTurnItem["type"] | null = null;
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index]!;
    if (item.runId === null) continue;
    if (item.runId !== runId) break;
    if (item.type === "subagent") subagents += 1;
    newest ??= item.type;
  }

  // Subagent work outranks the phase hint, matching the source's state priority.
  if (subagents >= 2) return "juggling2";
  if (subagents === 1) return "juggling";

  switch (newest) {
    case "compaction":
      return "sweeping";
    case "checkpoint":
      return "carrying";
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return activeThreadCount >= 3 ? "working3" : activeThreadCount === 2 ? "working2" : "working";
    case "reasoning":
    case "assistant_message":
    case "proposed_plan":
    case "user_message":
      return "thinking";
    default:
      return "thinking";
  }
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
