import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { useNotebookStore } from "./notebookStore";

it("retains independent source, output and kernel choices across refresh and scopes", async () => {
  useNotebookStore.setState({ byThread: {} });
  const thread = scopeThreadRef(EnvironmentId.make("host-a"), ThreadId.make("thread-a"));
  const otherHost = scopeThreadRef(EnvironmentId.make("host-b"), thread.threadId);
  const otherThread = scopeThreadRef(thread.environmentId, ThreadId.make("thread-b"));
  const source = JSON.stringify(["kernel-a", "cell-1", "source"]);
  const outputs = JSON.stringify(["kernel-a", "cell-1", "outputs"]);
  const otherKernel = JSON.stringify(["kernel-b", "cell-1", "source"]);
  const store = useNotebookStore.getState();
  store.selectKernel(thread, "kernel-a");
  store.toggle(thread, source);
  store.selectKernel(thread, "kernel-b");
  store.toggle(thread, otherKernel);
  store.toggle(thread, otherKernel);

  const { storage, name } = useNotebookStore.persist.getOptions();
  const persisted = await storage!.getItem(name!);
  useNotebookStore.setState({ byThread: {} });
  await storage!.setItem(name!, persisted!);
  await useNotebookStore.persist.rehydrate();

  const state = useNotebookStore.getState().byThread;
  expect(state[scopedThreadKey(thread)]).toEqual({
    kernelId: "kernel-b",
    collapsed: { [source]: true, [otherKernel]: false },
  });
  expect(state[scopedThreadKey(thread)]?.collapsed[outputs]).toBeUndefined();
  expect(state[scopedThreadKey(otherHost)]).toBeUndefined();
  expect(state[scopedThreadKey(otherThread)]).toBeUndefined();
});
