import { describe, expect, it } from "vite-plus/test";

import { formatShortTimestamp, formatUsageChartTimestamp } from "./timestampFormat";

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
