import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
  setResult: vi.fn(),
}));

vi.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Error: "error" },
  notificationAsync: mocks.notificationAsync,
}));

vi.mock("./vcs", () => ({ vcsActionManager: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { set: mocks.setResult } }));

import {
  dismissGitActionResult,
  keepGitActionResultVisible,
  showGitActionResult,
} from "./use-vcs-action-state";

describe("showGitActionResult", () => {
  it("keeps an inspected error until dismissed, but still expires subsequent results", () => {
    vi.useFakeTimers();
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    using _result = { [Symbol.dispose]: dismissGitActionResult };
    const error = { type: "error", title: "Git action failed", description: "rejected" } as const;
    showGitActionResult(error);
    vi.advanceTimersByTime(4_000);

    keepGitActionResultVisible();
    vi.advanceTimersByTime(10_000);
    expect(mocks.setResult.mock.lastCall?.[1]).toBe(error);

    dismissGitActionResult();
    expect(mocks.setResult.mock.lastCall?.[1]).toBeNull();

    showGitActionResult(error);
    keepGitActionResultVisible();
    const success = { type: "success", title: "Pushed" } as const;
    showGitActionResult(success);
    vi.advanceTimersByTime(4_999);
    expect(mocks.setResult.mock.lastCall?.[1]).toBe(success);
    vi.advanceTimersByTime(1);
    expect(mocks.setResult.mock.lastCall?.[1]).toBeNull();
  });

  it("buzzes once per reported result with the matching feedback type", () => {
    mocks.notificationAsync.mockClear();
    showGitActionResult({ type: "success", title: "Pushed" });
    showGitActionResult({ type: "error", title: "Git action failed", description: "rejected" });
    dismissGitActionResult();

    expect(mocks.notificationAsync.mock.calls).toEqual([["success"], ["error"]]);
  });
});
