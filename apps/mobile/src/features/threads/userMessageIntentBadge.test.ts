import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

describe("resolveUserMessageIntentBadge", () => {
  it.each(["steer", "promoted_queued_to_steer"] as const)("labels a %s", (intent) => {
    expect(resolveUserMessageIntentBadge(intent)?.label).toBe("Steer");
  });

  it.each(["turn_start", "queued_turn", undefined] as const)(
    "does not label a %s as a steer",
    (intent) => {
      expect(resolveUserMessageIntentBadge(intent)).toBeNull();
    },
  );
});
