import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { revisionedQuery } from "./revisionedQuery";

// A stand-in query that counts its fetches.
function setup() {
  let fetches = 0;
  // Node removal runs on the registry's scheduler; releasing flushes it so the
  // next mount of the same revision builds a fresh node, as a React remount does.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const query = Atom.make(() => {
    fetches += 1;
    return fetches;
  }).pipe(Atom.keepAlive);
  const mount = async (revision: string | null | undefined) => {
    const release = registry.mount(revisionedQuery(query, revision));
    // A stale read refetches in a microtask, after the render that read it.
    await Promise.resolve();
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  return { registry, query, mount, fetches: () => fetches };
}

describe("revisionedQuery", () => {
  it("refetches once per new revision, not on the first read or a remount", async () => {
    const { mount, fetches } = setup();

    (await mount("mutation-1"))();
    expect(fetches()).toBe(1);

    (await mount("mutation-1"))();
    expect(fetches()).toBe(1);

    (await mount("mutation-2"))();
    expect(fetches()).toBe(2);
  });

  it("does not ping-pong while readers of the old and new revision overlap", async () => {
    const { mount, fetches } = setup();

    const releaseOld = await mount("mutation-1");
    const releaseNew = await mount("mutation-2");
    expect(fetches()).toBe(2);
    releaseOld();
    releaseNew();
  });

  it("refetches when an earlier revision is read again", async () => {
    const { mount, fetches } = setup();

    (await mount("mutation-1"))();
    (await mount("mutation-2"))();
    (await mount("mutation-1"))();
    expect(fetches()).toBe(3);
  });

  it("refetches a query another reader already cached on its first revisioned read", async () => {
    const { mount, fetches } = setup();

    (await mount(undefined))();
    expect(fetches()).toBe(1);

    (await mount("mutation-1"))();
    expect(fetches()).toBe(2);

    (await mount("mutation-1"))();
    expect(fetches()).toBe(2);
  });

  it("does not refetch a cached query on a first read before any workspace change", async () => {
    const { mount, fetches } = setup();

    (await mount(undefined))();
    (await mount(null))();
    expect(fetches()).toBe(1);
  });

  it("leaves the query alone when read without a revision", async () => {
    const { mount, query, fetches } = setup();

    (await mount("mutation-1"))();
    expect(revisionedQuery(query, undefined)).toBe(query);
    (await mount(undefined))();
    (await mount("mutation-1"))();
    expect(fetches()).toBe(1);
  });

  it("refetches the query when the reader is refreshed", async () => {
    const { registry, query, mount, fetches } = setup();

    const release = await mount("mutation-1");
    registry.refresh(revisionedQuery(query, "mutation-1"));
    expect(fetches()).toBe(2);
    release();
  });

  it("evicts an idleTTL-0 query even under a non-zero defaultIdleTTL and fetches once on remount", async () => {
    let fetches = 0;
    const scheduled: Array<() => void> = [];
    const registry = AtomRegistry.make({
      defaultIdleTTL: 60_000,
      scheduleTask: (task) => {
        scheduled.push(task);
        return () => {};
      },
    });
    const connection = Atom.make(1);
    const query = Atom.make((get) => {
      get(connection);
      fetches += 1;
      return fetches;
    }).pipe(Atom.setIdleTTL(0));

    const wrapped = revisionedQuery(query, "mutation-1");
    const first = registry.mount(wrapped);
    await Promise.resolve();
    expect(fetches).toBe(1);

    first();
    while (scheduled.length > 0) {
      for (const task of scheduled.splice(0)) task();
    }
    expect(registry.getNodes().has(wrapped)).toBe(false);
    expect(registry.getNodes().has(query)).toBe(false);

    // Reconnect while unmounted must not refetch the evicted query.
    registry.set(connection, 2);
    await Promise.resolve();
    expect(fetches).toBe(1);

    const second = registry.mount(revisionedQuery(query, "mutation-2"));
    await Promise.resolve();
    expect(fetches).toBe(2);
    second();
  });

  it("drops a pending refetch when the registry is disposed before it runs", async () => {
    const { registry, query, mount } = setup();

    (await mount("mutation-1"))();
    const release = registry.mount(revisionedQuery(query, "mutation-2"));
    release();
    registry.dispose();

    // A refetch that ran now would throw "registry is disposed" as an uncaught error.
    await Promise.resolve();
  });
});
