import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { awaitAtomValue } from "./awaitAtom.ts";

describe("awaitAtomValue", () => {
  it("waits for a thread that is not loaded yet instead of failing", async () => {
    const registry = AtomRegistry.make();
    const thread = Atom.make<string | null>(null);
    const pending = awaitAtomValue(registry, thread, (value) => value, AbortSignal.abort());
    await expect(pending).rejects.toThrow("still synchronizing");

    const loading = awaitAtomValue(
      registry,
      thread,
      (value) => value,
      new AbortController().signal,
    );
    registry.set(thread, "loaded");
    await expect(loading).resolves.toBe("loaded");
  });

  it("stops observing the thread once its value arrives", async () => {
    const registry = AtomRegistry.make();
    const thread = Atom.make<string | null>(null);
    let reads = 0;
    const loading = awaitAtomValue(
      registry,
      thread,
      (value) => {
        reads++;
        return value;
      },
      new AbortController().signal,
    );
    registry.set(thread, "loaded");
    await expect(loading).resolves.toBe("loaded");
    const settledReads = reads;
    registry.set(thread, "changed later");
    expect(reads).toBe(settledReads);
  });
});
