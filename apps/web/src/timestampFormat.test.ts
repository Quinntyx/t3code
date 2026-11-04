import { describe, expect, it } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatShortTimestamp,
  formatUpcomingTimestamp,
  formatUsageChartTimestamp,
} from "./timestampFormat";

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});

const DAY_MS = 86_400_000;

describe("formatUsageChartTimestamp", () => {
  it("switches from clock times to dates at a full day of chart history", () => {
    const date = new Date(2026, 10, 2, 13, 0);
    const iso = date.toISOString();
    const dateLabel = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(date);

    expect(formatUsageChartTimestamp(iso, "12-hour", DAY_MS - 1)).toBe(
      formatShortTimestamp(iso, "12-hour"),
    );
    expect(formatUsageChartTimestamp(iso, "24-hour", DAY_MS - 1)).toBe("13:00");
    expect(formatUsageChartTimestamp(iso, "locale", DAY_MS)).toBe(dateLabel);
    expect(formatUsageChartTimestamp(iso, "12-hour", 2 * DAY_MS)).toBe(dateLabel);
    expect(formatUsageChartTimestamp(iso, "24-hour", 7 * DAY_MS)).toBe(dateLabel);
    expect(formatUsageChartTimestamp("invalid", "locale", DAY_MS)).toBe("");
  });
});
