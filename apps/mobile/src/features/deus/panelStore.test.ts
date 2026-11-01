import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createDeusPanelStore } from "./panelStore";

const a = { environmentId: EnvironmentId.make("a"), projectId: ProjectId.make("project") };
const b = { environmentId: EnvironmentId.make("b"), projectId: ProjectId.make("project") };

it("keeps the pinned destination until explicit switch confirmation and completed local cleanup", async () => {
  const store = createDeusPanelStore();
  store.getState().openPicker();
  store.getState().select(a);
  const stopping = Promise.withResolvers<void>();
  const stop = vi.fn(() => stopping.promise);
  store.getState().localAttachment.register(a, stop);
  store.getState().openPicker();
  store.getState().select(b);
  expect(store.getState().target).toEqual(a);
  store.getState().cancelSwitch();
  expect(stop).not.toHaveBeenCalled();
  store.getState().openPicker();
  store.getState().select(b);
  const switching = store.getState().confirmSwitch();
  expect(store.getState().target).toEqual(a);
  stopping.resolve();
  await switching;
  expect(store.getState().target).toEqual(b);
  expect(stop).toHaveBeenCalledOnce();
});

it("visits a real worker and returns to the pinned Deus destination without opening media", async () => {
  const store = createDeusPanelStore();
  store.getState().select(a);
  expect(await store.getState().visitWorker()).toBe(true);
  expect(store.getState().visible).toBe(false);
  expect(store.getState().target).toEqual(a);
  store.getState().select(a);
  expect(store.getState().visible).toBe(true);
  expect(store.getState().localAttachment.has(a)).toBe(false);
});

it("keeps failed local cleanup visible and retryable instead of losing ownership", async () => {
  const store = createDeusPanelStore();
  store.getState().select(a);
  const stop = vi
    .fn()
    .mockRejectedValueOnce(new Error("detach failed"))
    .mockResolvedValue(undefined);
  store.getState().localAttachment.register(a, stop);
  await store.getState().close();
  expect(store.getState().visible).toBe(true);
  expect(store.getState().error).toBe("detach failed");
  expect(store.getState().target).toEqual(a);
  await store.getState().close();
  expect(store.getState().visible).toBe(false);
  expect(stop).toHaveBeenCalledTimes(2);
});
