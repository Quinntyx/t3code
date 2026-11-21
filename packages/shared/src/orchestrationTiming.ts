import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2RunStatus,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";

export function deriveSubagentElapsedMs(
  agent: {
    readonly status: OrchestrationV2Subagent["status"];
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  },
  nowMs: number,
): number | null {
  if (agent.startedAt === null) return null;
  const end = isOrchestrationV2WorkActive(agent.status)
    ? nowMs
    : agent.completedAt === null
      ? null
      : Date.parse(agent.completedAt);
  if (end === null) return null;
  const start = Date.parse(agent.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/**
 * Anchors live extrapolation in client-clock coordinates (translating server timestamps via
 * `dataUpdatedAt - readAt` so client/server clock skew never stalls or inflates the ticker), and
 * freezes at `completedAt` while the final usage snapshot is still in flight.
 */
export function deriveThreadWorkedDuration(input: {
  readonly durationMs: number | undefined;
  readonly readAt?: string | undefined;
  readonly dataUpdatedAt: number;
  readonly isPending?: boolean;
  readonly latestRun:
    | {
        readonly status: OrchestrationV2RunStatus;
        readonly startedAt: string | null;
        readonly completedAt: string | null;
      }
    | null
    | undefined;
}): { readonly baseMs: number; readonly liveFromMs: number | null } | null {
  if (input.durationMs === undefined) return null;
  const readAtMs = input.readAt !== undefined ? Date.parse(input.readAt) : Number.NaN;
  const hasServerReadAt = Number.isFinite(readAtMs);
  const snapshotMs = hasServerReadAt
    ? readAtMs
    : input.dataUpdatedAt > 0
      ? input.dataUpdatedAt
      : Number.NaN;
  const status = input.latestRun?.status;
  const running = status === "starting" || status === "running" || status === "waiting";
  const startedAtMs =
    input.latestRun?.startedAt !== null && input.latestRun?.startedAt !== undefined
      ? Date.parse(input.latestRun.startedAt)
      : Number.NaN;
  if (running) {
    let liveFromMs: number | null = null;
    if (Number.isFinite(startedAtMs)) {
      const serverAnchorMs = Number.isFinite(snapshotMs)
        ? Math.max(snapshotMs, startedAtMs)
        : startedAtMs;
      liveFromMs =
        hasServerReadAt && input.dataUpdatedAt > 0
          ? serverAnchorMs + (input.dataUpdatedAt - readAtMs)
          : serverAnchorMs;
    }
    if (input.durationMs <= 0 && liveFromMs === null) return null;
    return { baseMs: input.durationMs, liveFromMs };
  }
  const completedAtMs =
    input.latestRun?.completedAt !== null && input.latestRun?.completedAt !== undefined
      ? Date.parse(input.latestRun.completedAt)
      : Number.NaN;
  const pendingCompletedMs =
    Number.isFinite(snapshotMs) &&
    Number.isFinite(startedAtMs) &&
    Number.isFinite(completedAtMs) &&
    // Older servers omit `readAt`; gate their fallback on `isPending` so a skewed remote clock never permanently over-counts once settled.
    (hasServerReadAt || input.isPending === true) &&
    snapshotMs < completedAtMs
      ? Math.max(0, completedAtMs - Math.max(snapshotMs, startedAtMs))
      : 0;
  const baseMs = input.durationMs + pendingCompletedMs;
  if (baseMs <= 0) return null;
  return { baseMs, liveFromMs: null };
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${Math.round(durationMs / 100) / 10}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || minutes > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}
