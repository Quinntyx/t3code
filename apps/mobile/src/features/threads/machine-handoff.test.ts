import { describe, expect, it, vi } from "vite-plus/test";

import {
  machineHandoffBlocker,
  relayMachineHandoff,
  sourceProjectSubdirectory,
} from "./machine-handoff";

const ready = {
  sourceAvailable: true,
  sourceStatus: "completed",
  sourceConnected: true,
  targetConnected: true,
  sourceSupported: true,
  targetSupported: true,
  canExport: true,
  canImport: true,
  projectSelected: true,
  modelReady: true,
};

describe("machine handoff", () => {
  it("refuses active sources, unavailable machines, permissions and missing destinations", () => {
    expect(machineHandoffBlocker(ready)).toBeNull();
    for (const sourceStatus of ["preparing", "queued", "starting", "running", "waiting"]) {
      expect(machineHandoffBlocker({ ...ready, sourceStatus })).toContain("Stop");
    }
    for (const key of [
      "sourceAvailable",
      "sourceConnected",
      "targetConnected",
      "sourceSupported",
      "targetSupported",
      "canExport",
      "canImport",
      "projectSelected",
      "modelReady",
    ] as const) {
      expect(machineHandoffBlocker({ ...ready, [key]: false })).not.toBeNull();
    }
  });

  it("relays the opaque snapshot unchanged and rechecks eligibility before importing", async () => {
    const snapshot = { opaque: "do not inspect" };
    const importSnapshot = vi.fn(async (value: typeof snapshot) => value);
    const eligibility = vi
      .fn<() => string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValue("Permission revoked");
    await expect(
      relayMachineHandoff({
        eligibility,
        exportSnapshot: async () => snapshot,
        importSnapshot,
      }),
    ).rejects.toThrow("Permission revoked");
    expect(importSnapshot).not.toHaveBeenCalled();
    await expect(
      relayMachineHandoff({
        eligibility: () => null,
        exportSnapshot: async () => snapshot,
        importSnapshot,
      }),
    ).resolves.toBe(snapshot);
    expect(importSnapshot.mock.calls[0]?.[0]).toBe(snapshot);
  });

  it("does not export a blocked source or import after a failed export", async () => {
    const exportSnapshot = vi.fn(async () => {
      throw new Error("Export rejected");
    });
    const importSnapshot = vi.fn(async () => undefined);
    await expect(
      relayMachineHandoff({
        eligibility: () => "Source is active",
        exportSnapshot,
        importSnapshot,
      }),
    ).rejects.toThrow("Source is active");
    expect(exportSnapshot).not.toHaveBeenCalled();
    await expect(
      relayMachineHandoff({ eligibility: () => null, exportSnapshot, importSnapshot }),
    ).rejects.toThrow("Export rejected");
    expect(importSnapshot).not.toHaveBeenCalled();
  });

  it("preserves repository-relative project paths without accepting sibling prefixes", () => {
    expect(sourceProjectSubdirectory("/repo", "/repo/apps/mobile")).toBe("apps/mobile");
    expect(sourceProjectSubdirectory("C:\\repo\\", "C:\\repo\\apps\\mobile")).toBe("apps/mobile");
    expect(sourceProjectSubdirectory("/repo/", "/repo")).toBe("");
    expect(sourceProjectSubdirectory("/repo", "/repository/other")).toBeNull();
    expect(sourceProjectSubdirectory(undefined, "/repo/apps/mobile")).toBeNull();
    expect(sourceProjectSubdirectory("/repo", "/repo/../elsewhere")).toBeNull();
    expect(sourceProjectSubdirectory("", "/repo/apps/mobile")).toBeNull();
  });
});
