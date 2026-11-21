import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  finishMachineHandoff,
  openMachineHandoff,
  setMachineHandoffSelection,
  useMachineHandoffRequest,
} from "./machineHandoffRequest";

const request = (id: string) => ({
  threadRef: scopeThreadRef(EnvironmentId.make("source"), ThreadId.make(id)),
  destination: scopeProjectRef(EnvironmentId.make("target"), ProjectId.make("project")),
});
const running = () =>
  useMachineHandoffRequest.getState().requests.find((attempt) => attempt.status === "running");

beforeEach(() => {
  useMachineHandoffRequest.setState({ requests: [], session: 0 });
});

describe("machine handoff requests", () => {
  it("retains clone completion until the active move finishes, without duplicating it", () => {
    const active = request("moving");
    const cloned = request("cloned");
    openMachineHandoff(active);
    const original = running()!;
    openMachineHandoff(cloned);
    openMachineHandoff({ ...cloned });
    expect(running()).toBe(original);
    finishMachineHandoff(original.session, true);
    expect(running()?.request).toBe(cloned);
    finishMachineHandoff(running()!.session, true);
    expect(useMachineHandoffRequest.getState().requests).toEqual([]);
  });

  it("retains failed attempt identity while another thread moves", () => {
    const failed = request("failed");
    const selection = { instanceId: ProviderInstanceId.make("provider"), model: "model" };
    openMachineHandoff(failed);
    const originalSession = running()!.session;
    setMachineHandoffSelection(originalSession, selection);
    openMachineHandoff(request("other"));
    finishMachineHandoff(originalSession, false);
    const other = running()!;
    expect(other.request.threadRef.threadId).toBe("other");
    openMachineHandoff({ ...failed });
    expect(running()).toBe(other);
    finishMachineHandoff(other.session, true);
    expect(running()).toMatchObject({
      session: originalSession,
      request: failed,
      retry: 1,
      selection,
    });
    finishMachineHandoff(originalSession, true);
    expect(useMachineHandoffRequest.getState().requests).toEqual([]);
  });
});
