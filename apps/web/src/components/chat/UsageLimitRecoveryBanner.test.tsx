import { IsoDateTime, RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("does not offer provider recovery for a thread's own consumption cap", () => {
    const item = usageLimitRecoveryBannerItem({
      runId: RunId.make("run-1"),
      errorCode: null,
      resetAt: new Date(2026, 9, 20, 17, 30).toISOString(),
      stoppedAt: stoppedAt.toISOString(),
      settled: false,
      requestPending: false,
      snoozedUntil: null,
      recovery: null,
      consumptionCapHit: {
        at: IsoDateTime.make(stoppedAt.toISOString()),
        reason: "API spend reached $1.00.",
      },
      timestampFormat: "24-hour",
      onChange: async () => {},
    });
    expect(item.actions).toBeUndefined();
    expect(item.title).toBe("Consumption cap reached");
    expect(item.description).toContain("Raise or remove the thread's consumption cap");
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});
