import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { updateHiddenThreadKeys } from "./hidden-threads";

const first = { environmentId: EnvironmentId.make("first"), id: ThreadId.make("same") };
const second = { environmentId: EnvironmentId.make("second"), id: ThreadId.make("same") };

describe("device-local hidden threads", () => {
  it("stores only the scoped thread identity", () => {
    expect(updateHiddenThreadKeys([], first, true)).toEqual(["first:same"]);
  });

  it("keeps a thread hidden through updates until explicitly restored", () => {
    const keys = updateHiddenThreadKeys([], first, true);
    expect(updateHiddenThreadKeys(keys, first, true)).toEqual(keys);
    const updated = { ...first, updatedAt: "2026-10-27T23:00:00Z", settledAt: null };
    expect(updateHiddenThreadKeys(keys, updated, true)).toBe(keys);
    expect(updateHiddenThreadKeys(keys, first, false)).toEqual([]);
  });

  it("composes hides without dropping another environment or mutating the previous list", () => {
    const keys = updateHiddenThreadKeys([], first, true);
    const next = updateHiddenThreadKeys(keys, second, true);
    expect(keys).toHaveLength(1);
    expect(next).toHaveLength(2);
    const restored = updateHiddenThreadKeys(next, first, false);
    expect(restored).toEqual(["second:same"]);
  });
});
