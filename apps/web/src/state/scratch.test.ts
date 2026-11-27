import { describe, expect, it } from "vite-plus/test";

import { readScratchViewState, writeScratchViewState, type ScratchViewState } from "./scratch";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("scratch view state", () => {
  it("round-trips a scroll position per scratch key", () => {
    const storage = memoryStorage();
    const view: ScratchViewState = { scrollTop: 1200 };

    writeScratchViewState("repo:one", view, storage);

    expect(readScratchViewState("repo:one", storage)).toEqual(view);
    expect(readScratchViewState("repo:two", storage)).toBeNull();
  });

  it("recovers cleanly when the stored record is malformed", () => {
    const storage = memoryStorage({ "t3code:scratch-view:v1": "not json" });

    expect(readScratchViewState("repo:one", storage)).toBeNull();

    writeScratchViewState("repo:one", { scrollTop: 4 }, storage);

    expect(readScratchViewState("repo:one", storage)).toEqual({ scrollTop: 4 });
  });

  it("clamps negative positions", () => {
    const storage = memoryStorage();

    writeScratchViewState("repo:one", { scrollTop: -10 }, storage);

    expect(readScratchViewState("repo:one", storage)).toEqual({ scrollTop: 0 });
  });
});
