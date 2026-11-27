import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildBuddyClipUrl, createBuddyCatalogStore } from "./buddySources";

const remoteAccess: DeviceHubAccess = {
  httpBase: "https://remote.example.test/api/buddies",
  wsBase: "wss://remote.example.test/api/buddies",
  query: { wsTicket: "ticket-1" },
  credentials: false,
};

const cookieAccess: DeviceHubAccess = {
  httpBase: "http://localhost:3773/api/buddies",
  wsBase: "ws://localhost:3773/api/buddies",
  query: {},
  credentials: true,
};

const manifest = {
  id: "hero",
  name: "Hero",
  description: "A buddy",
  author: "Tester",
  license: "MIT",
  aspectRatio: 1,
  clips: { idle: "idle.webm" },
};

describe("buddySources", () => {
  it("builds environment-targeted clip URLs with ticket auth and cache revision", () => {
    const url = buildBuddyClipUrl(remoteAccess, "/opt/buddies", "hero", "idle.webm", 3);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://remote.example.test");
    expect(parsed.pathname).toBe("/api/buddies/clip");
    expect(parsed.searchParams.get("folder")).toBe("/opt/buddies");
    expect(parsed.searchParams.get("buddy")).toBe("hero");
    expect(parsed.searchParams.get("file")).toBe("idle.webm");
    expect(parsed.searchParams.get("v")).toBe("3");
    expect(parsed.searchParams.get("wsTicket")).toBe("ticket-1");
  });

  it("clears stale folders when the last folder is removed and ignores out-of-order responses", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValueOnce(firstPromise);
    const store = createBuddyCatalogStore(fetchMock);

    const inflight = store.load({
      key: "env-1\0/opt/buddies",
      folderPaths: ["/opt/buddies"],
      access: cookieAccess,
    });
    expect(store.getSnapshot().loading).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3773/api/buddies/catalog", {
      cache: "no-store",
      credentials: "include",
    });

    // Clearing while the earlier request is still in flight must drop the late response.
    store.clear();
    expect(store.getSnapshot()).toEqual({ key: "", folders: [], loading: false, revision: 0 });

    resolveFirst(
      new Response(
        JSON.stringify({
          folders: [{ folderPath: "/opt/buddies", buddies: [manifest], error: null }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await inflight;

    expect(store.getSnapshot()).toEqual({ key: "", folders: [], loading: false, revision: 0 });
  });

  it("retries once with a renewed media ticket when a remote catalog read returns 401", async () => {
    const renewed: DeviceHubAccess = { ...remoteAccess, query: { wsTicket: "ticket-2" } };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            folders: [{ folderPath: "~/buddies", buddies: [manifest], error: null }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const renewAccess = vi.fn(async () => renewed);
    const store = createBuddyCatalogStore(fetchMock);

    await store.load({
      key: "env-remote\0~/buddies",
      folderPaths: ["~/buddies"],
      access: remoteAccess,
      renewAccess,
      bumpRevision: true,
    });

    expect(renewAccess).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://remote.example.test/api/buddies/catalog?wsTicket=ticket-1",
      { cache: "no-store", credentials: "same-origin" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://remote.example.test/api/buddies/catalog?wsTicket=ticket-2",
      { cache: "no-store", credentials: "same-origin" },
    );
    expect(store.getSnapshot()).toEqual({
      key: "env-remote\0~/buddies",
      folders: [{ folderPath: "~/buddies", buddies: [manifest], error: null }],
      loading: false,
      revision: 1,
    });
  });
});
