import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentElapsedMs, deriveThreadWorkedDuration } from "./orchestrationTiming.ts";

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});

describe("deriveThreadWorkedDuration", () => {
  const prevUpdatedAt = Date.parse("2026-09-21T10:00:00.000Z");
  const runStartedAt = "2026-09-21T12:00:00.000Z";
  const runStartedAtMs = Date.parse(runStartedAt);
  const freshUpdatedAt = Date.parse("2026-09-21T12:00:05.000Z");
  const runCompletedAt = "2026-09-21T12:05:00.000Z";
  const postCompleteUpdatedAt = Date.parse("2026-09-21T12:05:01.000Z");

  it("anchors a newly started run to its start time so the prior idle gap is not counted", () => {
    expect(
      deriveThreadWorkedDuration({
        durationMs: 30_000,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "running", startedAt: runStartedAt, completedAt: null },
      }),
    ).toEqual({ baseMs: 30_000, liveFromMs: runStartedAtMs });

    expect(
      deriveThreadWorkedDuration({
        durationMs: 35_000,
        dataUpdatedAt: freshUpdatedAt,
        latestRun: { status: "running", startedAt: runStartedAt, completedAt: null },
      }),
    ).toEqual({ baseMs: 35_000, liveFromMs: freshUpdatedAt });

    expect(
      deriveThreadWorkedDuration({
        durationMs: 30_000,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "starting", startedAt: null, completedAt: null },
      }),
    ).toEqual({ baseMs: 30_000, liveFromMs: null });
  });

  it.each([
    ["client ahead by 5m", 5 * 60_000],
    ["client behind by 5m", -5 * 60_000],
  ])("keeps live elapsed time accurate when %s", (_label, skewMs) => {
    const serverNowAt11s = runStartedAtMs + 11_000;
    const clientNowAt11s = serverNowAt11s + skewMs;

    // Pre-run snapshot: anchor translates startedAt into client clock via dataUpdatedAt - readAt.
    const preRun = deriveThreadWorkedDuration({
      durationMs: 30_000,
      readAt: "2026-09-21T10:00:00.000Z",
      dataUpdatedAt: prevUpdatedAt + skewMs,
      latestRun: { status: "running", startedAt: runStartedAt, completedAt: null },
    });
    expect(preRun).not.toBeNull();
    expect(preRun!.baseMs + Math.max(0, clientNowAt11s - preRun!.liveFromMs!)).toBe(41_000);

    // Mid-run snapshot at +5s: ticks smoothly from client receipt time to 41s at +11s.
    const midRun = deriveThreadWorkedDuration({
      durationMs: 35_000,
      readAt: "2026-09-21T12:00:05.000Z",
      dataUpdatedAt: freshUpdatedAt + skewMs,
      latestRun: { status: "running", startedAt: runStartedAt, completedAt: null },
    });
    expect(midRun).not.toBeNull();
    expect(midRun!.baseMs + Math.max(0, clientNowAt11s - midRun!.liveFromMs!)).toBe(41_000);
  });

  it("freezes at the run completion time until a usage snapshot after completion arrives", () => {
    const prevReadAt = "2026-09-21T10:00:00.000Z";
    const midRunReadAt = "2026-09-21T12:00:05.000Z";
    const postCompleteReadAt = "2026-09-21T12:05:01.000Z";

    // First run completes before the final usage snapshot lands: stays visible at 5m.
    expect(
      deriveThreadWorkedDuration({
        durationMs: 0,
        readAt: prevReadAt,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "completed", startedAt: runStartedAt, completedAt: runCompletedAt },
      }),
    ).toEqual({ baseMs: 300_000, liveFromMs: null });

    // Mid-run snapshot sampled before completion but delivered after completion: uses server readAt.
    expect(
      deriveThreadWorkedDuration({
        durationMs: 35_000,
        readAt: midRunReadAt,
        dataUpdatedAt: postCompleteUpdatedAt,
        latestRun: { status: "completed", startedAt: runStartedAt, completedAt: runCompletedAt },
      }),
    ).toEqual({ baseMs: 330_000, liveFromMs: null });

    // Post-completion snapshot on a server whose clock is ahead of the client: does not over-count.
    expect(
      deriveThreadWorkedDuration({
        durationMs: 330_000,
        readAt: postCompleteReadAt,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "completed", startedAt: runStartedAt, completedAt: runCompletedAt },
      }),
    ).toEqual({ baseMs: 330_000, liveFromMs: null });

    // Older server without readAt: freezes while completion refetch is pending, settles once done.
    expect(
      deriveThreadWorkedDuration({
        durationMs: 35_000,
        dataUpdatedAt: freshUpdatedAt,
        isPending: true,
        latestRun: { status: "completed", startedAt: runStartedAt, completedAt: runCompletedAt },
      }),
    ).toEqual({ baseMs: 330_000, liveFromMs: null });
    expect(
      deriveThreadWorkedDuration({
        durationMs: 330_000,
        dataUpdatedAt: prevUpdatedAt,
        isPending: false,
        latestRun: { status: "completed", startedAt: runStartedAt, completedAt: runCompletedAt },
      }),
    ).toEqual({ baseMs: 330_000, liveFromMs: null });
  });

  it("shows a zero-duration baseline once the first run starts and hides idle or missing durations", () => {
    expect(
      deriveThreadWorkedDuration({
        durationMs: 0,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "running", startedAt: runStartedAt, completedAt: null },
      }),
    ).toEqual({ baseMs: 0, liveFromMs: runStartedAtMs });

    expect(
      deriveThreadWorkedDuration({
        durationMs: 0,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "starting", startedAt: null, completedAt: null },
      }),
    ).toBeNull();

    expect(
      deriveThreadWorkedDuration({
        durationMs: 0,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: null,
      }),
    ).toBeNull();

    expect(
      deriveThreadWorkedDuration({
        durationMs: undefined,
        dataUpdatedAt: prevUpdatedAt,
        latestRun: { status: "running", startedAt: runStartedAt, completedAt: null },
      }),
    ).toBeNull();
  });
});
