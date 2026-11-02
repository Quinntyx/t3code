import { act } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  preferences: {} as unknown,
  active: true,
  capture: vi.fn<() => Promise<string>>(),
  convert: vi.fn(),
  load: vi.fn(),
  create: vi.fn(),
  text: vi.fn(),
  append: vi.fn(),
  dispatch: vi.fn(),
  alert: vi.fn(),
  addListener: vi.fn(),
  remove: vi.fn(),
  restoreConsole: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => harness.preferences }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ captureScreenshot: harness.capture }),
}));
vi.mock("expo-sensors", () => ({
  Accelerometer: { setUpdateInterval: vi.fn(), addListener: harness.addListener },
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    push: (name: string, params: unknown) => ({ type: "PUSH", payload: { name, params } }),
  },
}));
vi.mock("../../lib/appState", () => ({ useAppActive: () => harness.active }));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { isReady: () => true, dispatch: harness.dispatch },
}));
vi.mock("../../lib/composerImages", () => ({ convertPastedImagesToAttachments: harness.convert }));
vi.mock("../../components/ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("./debug-shake-logs", () => ({
  captureConsoleTail: () => ({
    read: () => "[warn] original problem",
    dispose: harness.restoreConsole,
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: harness.load,
  createNewTaskDraft: harness.create,
  setComposerDraftText: harness.text,
  appendComposerDraftAttachments: harness.append,
}));

import { DebugShakeCoordinator } from "./DebugShakeCoordinator";

function setup(enabled = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  harness.active = true;
  const project = { environmentId: "remote-machine", projectId: "t3code" };
  harness.preferences = AsyncResult.success({
    debugShakeEnabled: enabled,
    debugShakeProject: project,
  });
  harness.capture.mockResolvedValue("file:///screenshot.png");
  harness.convert.mockResolvedValue([{ id: "image", type: "image" }]);
  harness.load.mockResolvedValue(undefined);
  harness.create.mockReturnValue("new-debug-draft");
  harness.addListener.mockReturnValue({ remove: harness.remove });
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<DebugShakeCoordinator />));
  return {
    shake(timestamp = 1) {
      const sample = harness.addListener.mock.calls.at(-1)![0] as (sample: {
        x: number;
        y: number;
        z: number;
        timestamp: number;
      }) => void;
      sample({ x: 3, y: 0, z: 0, timestamp });
      sample({ x: 3, y: 0, z: 0, timestamp: timestamp + 0.1 });
    },
    enable(value: boolean) {
      harness.preferences = AsyncResult.success({
        debugShakeEnabled: value,
        debugShakeProject: project,
      });
      act(() => root.render(<DebugShakeCoordinator />));
    },
    background() {
      harness.active = false;
      act(() => root.render(<DebugShakeCoordinator />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("captures before navigation and stages one independent draft despite repeated shakes", async () => {
  using screen = setup(false);
  expect(harness.addListener).not.toHaveBeenCalled();
  screen.enable(true);
  const screenshot = Promise.withResolvers<string>();
  harness.capture.mockReturnValueOnce(screenshot.promise);
  await act(async () => {
    screen.shake();
    screen.shake(5);
    expect(harness.capture).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).not.toHaveBeenCalled();
    screenshot.resolve("file:///screenshot.png");
    await screenshot.promise;
  });
  expect(harness.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: "remote-machine",
    projectId: "t3code",
  });
  expect(harness.text).toHaveBeenCalledWith(
    "new-debug-draft",
    expect.stringContaining("[warn] original problem"),
  );
  expect(harness.append).toHaveBeenCalledWith("new-debug-draft", [{ id: "image", type: "image" }]);
  expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "PUSH",
    payload: {
      name: "Thread",
      params: {
        draft: { environmentId: "remote-machine", projectId: "t3code", draftId: "new-debug-draft" },
      },
    },
  });
  expect(harness.alert).not.toHaveBeenCalled();
});

it.each(["disable", "background"])(
  "cancels a capture on %s without leaving a draft or navigation",
  async (transition) => {
    using screen = setup();
    const screenshot = Promise.withResolvers<string>();
    harness.capture.mockReturnValueOnce(screenshot.promise);
    screen.shake();
    if (transition === "disable") screen.enable(false);
    else screen.background();
    await act(async () => {
      screenshot.resolve("file:///screenshot.png");
      await screenshot.promise;
    });
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.convert).toHaveBeenCalled();
    if (transition === "disable") expect(harness.restoreConsole).toHaveBeenCalledTimes(1);
  },
);

it("leaves no empty draft on capture failure and allows a later retry", async () => {
  using screen = setup();
  harness.capture.mockRejectedValueOnce(new Error("Unavailable window"));
  await act(async () => screen.shake());
  expect(harness.create).not.toHaveBeenCalled();
  expect(harness.alert).toHaveBeenCalledWith(
    "Could not capture debug report",
    "Unavailable window",
  );
  await act(async () => screen.shake(5));
  expect(harness.dispatch).toHaveBeenCalledTimes(1);
});
