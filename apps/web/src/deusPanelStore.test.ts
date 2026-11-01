import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createDeusPanelStore } from "./deusPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRightPanelStore, selectThreadRightPanelState } from "./rightPanelStore";

const first = { environmentId: EnvironmentId.make("one"), projectId: ProjectId.make("project") };
const second = { ...first, projectId: ProjectId.make("other") };

describe("project-owned Deus panel", () => {
  it("leaves existing worker utility ownership and maximized state intact", async () => {
    const previous = useRightPanelStore.getState();
    try {
      const a = scopeThreadRef(first.environmentId, ThreadId.make("worker-a"));
      const b = scopeThreadRef(first.environmentId, ThreadId.make("worker-b"));
      previous.open(a, "files");
      previous.open(b, "diff");
      previous.setMaximized(a, true);
      const owned = useRightPanelStore.getState().byThreadKey;
      const store = createDeusPanelStore();
      store.getState().requestOpen(first);
      store.getState().setMaximized(true);
      store.getState().requestOpen(second);
      await store.getState().confirmSwitch();
      await store.getState().close();
      expect(useRightPanelStore.getState().byThreadKey).toBe(owned);
      expect(selectThreadRightPanelState(owned, a).maximized).toBe(true);
      expect(selectThreadRightPanelState(owned, b).surfaces.map((surface) => surface.kind)).toEqual(
        ["diff"],
      );
    } finally {
      useRightPanelStore.setState(previous, true);
    }
  });
  it("opens without capturing media and only explicitly runs destination voice actions", () => {
    const store = createDeusPanelStore();
    const actions: string[] = [];
    store.getState().registerVoice(first, {
      ready: true,
      active: false,
      muted: false,
      connect: () => actions.push("connect"),
      disconnect: () => actions.push("disconnect"),
      toggleMute: () => actions.push("mute"),
    });
    store.getState().requestOpen(first);
    expect(actions).toEqual([]);
    store.getState().voice?.controls.connect();
    expect(actions).toEqual(["connect"]);
    store.getState().unregisterVoice(second);
    expect(store.getState().voice).not.toBeNull();
    store.getState().unregisterVoice(first);
    expect(store.getState().voice).toBeNull();
  });
  it("keeps its target and identity on repeat entry, without any thread owner", () => {
    const store = createDeusPanelStore();
    store.getState().requestOpen(first);
    const target = store.getState().target;
    store.getState().setMaximized(true);
    store.getState().requestOpen({ ...first });
    expect(store.getState().target).toBe(target);
    expect(store.getState().maximized).toBe(true);
    expect(store.getState().pendingTarget).toBeNull();
  });
  it("requires explicit switch even for the same project ID on a different environment", async () => {
    const store = createDeusPanelStore();
    store.getState().requestOpen(first);
    const remote = { ...first, environmentId: EnvironmentId.make("two") };
    store.getState().requestOpen(remote);
    expect(store.getState().target).toEqual(first);
    expect(store.getState().pendingTarget).toEqual(remote);
    store.getState().cancelSwitch();
    expect(store.getState().target).toEqual(first);
    store.getState().requestOpen(second);
    await store.getState().confirmSwitch();
    expect(store.getState().target).toEqual(second);
  });
  it("waits for local release before switching and never cancels workers", async () => {
    const store = createDeusPanelStore();
    let complete!: () => void;
    const stopped = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const operations: string[] = [];
    store.getState().requestOpen(first);
    store.getState().localAttachment.register(first, () => {
      operations.push("release-local");
      return stopped;
    });
    store.getState().requestOpen(second);
    const switching = store.getState().confirmSwitch();
    expect(store.getState().target).toEqual(first);
    expect(store.getState().busy).toBe(true);
    complete();
    await switching;
    expect(store.getState().target).toEqual(second);
    expect(operations).toEqual(["release-local"]);
    await store.getState().close();
    expect(store.getState().target).toBeNull();
  });
  it("does not switch or close when local teardown fails", async () => {
    const store = createDeusPanelStore();
    store.getState().requestOpen(first);
    store.getState().localAttachment.register(first, async () => {
      throw new Error("Release failed");
    });
    await store.getState().close();
    expect(store.getState().target).toEqual(first);
    expect(store.getState().error).toBe("Release failed");
  });
});
