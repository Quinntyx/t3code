import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const primary = EnvironmentId.make("environment-primary");
const remote = EnvironmentId.make("environment-remote");

// The primary connection is what decides native rendering; a unit test needs no catalog.
const state = vi.hoisted(() => ({ primaryEnvironmentId: null as string | null, electron: true }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.electron }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => state.primaryEnvironmentId },
}));

import { rendersServerTabNatively, streamsServerTabAudio } from "./previewRuntime";

describe("streamsServerTabAudio", () => {
  it("owns audio for a streamed tab whatever the host calls it", () => {
    state.primaryEnvironmentId = primary;
    // A CLI-hosted runner never set `headless`, and a remote client streams the same tab.
    expect(streamsServerTabAudio(remote, { runtime: "server" })).toBe(true);
    expect(streamsServerTabAudio(primary, { runtime: "server", headless: true })).toBe(true);
    expect(streamsServerTabAudio(remote, { runtime: "server", headless: true })).toBe(true);
  });

  it("leaves the tab this client renders natively to the desktop to mute", () => {
    state.primaryEnvironmentId = primary;
    const nativelyRendered = { runtime: "server" as const, headless: false };
    expect(rendersServerTabNatively(primary, primary, nativelyRendered)).toBe(true);
    expect(streamsServerTabAudio(primary, nativelyRendered)).toBe(false);
  });

  it("never claims a tab that is not a server tab", () => {
    state.primaryEnvironmentId = primary;
    expect(streamsServerTabAudio(primary, { runtime: "desktop" })).toBe(false);
    expect(streamsServerTabAudio(null, { runtime: "server" })).toBe(false);
  });
});
