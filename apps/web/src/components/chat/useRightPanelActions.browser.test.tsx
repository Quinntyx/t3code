import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { useDiffPanelStore } from "../../diffPanelStore";
import {
  selectThreadRightPanelState,
  threadRightPanelView,
  useRightPanelStore,
} from "../../rightPanelStore";
import { render } from "../../../test/render";
import { useRightPanelActions } from "./useRightPanelActions";

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../../voice/controller", () => ({
  activateVoice: () => {},
  connectVoiceMicrophone: async () => {},
  disconnectVoice: () => {},
  muteVoice: () => {},
  setVoiceOpen: () => {},
}));
vi.mock("../ChatOverlayHosts", () => ({ openDeviceSetupDialog: () => {} }));
vi.mock("../../lib/terminalFocus", () => ({
  focusActivePanelTerminal: () => {},
  focusTerminal: () => {},
}));
vi.mock("../../lib/workspaceFocus", () => ({
  requestWorkspaceContentFocus: () => {},
  requestWorkspaceFocus: () => {},
}));
vi.mock("../../previewStateStore", async (original) => ({
  ...(await original()),
  setActivePreviewTab: () => {},
  useThreadPreviewState: () => ({}),
}));
vi.mock("../preview/addBrowserSurface", () => ({ addBrowserSurface: async () => ({}) }));
vi.mock("../preview/agentOpenedPreviews", () => ({ floatDeviceSurface: () => {} }));
vi.mock("../../previewMiniPlayerStore", () => ({
  browserMiniPlayerSource: () => ({}),
  usePreviewMiniPlayerStore: { getState: () => ({ open: () => {} }) },
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: () => ({}),
  toastManager: { add: () => {} },
}));

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-A"),
};

function Harness() {
  const diffOpen = useRightPanelStore(
    (state) =>
      threadRightPanelView(selectThreadRightPanelState(state.byThreadKey, ref), {
        open: state.voiceOpen,
        active: state.voiceActive,
      }).activeSurfaceId === "diff",
  );
  const { onOpenTurnDiffStable, onOpenToolDiffStable } = useRightPanelActions({
    activeThreadRef: ref,
    activeProject: null,
    activeRightPanelSurface: null,
    activePreviewState: {} as never,
    deviceState: {} as never,
    deviceStateLoaded: false,
    pullRequestPanelTarget: null,
    threadPanelPresentation: "inline",
    isServerThread: true,
    embedded: false,
    diffAvailable: true,
    browserAvailable: false,
    canOperatePreview: false,
    diffOpen,
    previewPanelOpen: false,
    rightPanelOpen: true,
    canMaximizeRightPanel: true,
    rightPanelMaximized: false,
    supportsPullRequests: false,
    pullRequestsSurfaceAvailable: false,
    gitCwd: null,
    activeProjectCwd: null,
    onDiffPanelOpen: undefined,
    closeRightPanelSurface: () => {},
  });
  return (
    <>
      <button onClick={() => onOpenTurnDiffStable(RunId.make("turn-1"))}>Open turn diff</button>
      <button
        onClick={() =>
          onOpenToolDiffStable({
            threadId: ref.threadId,
            itemId: TurnItemId.make("item-1"),
            revision: "r1",
          })
        }
      >
        Open tool diff
      </button>
    </>
  );
}

function reset() {
  useRightPanelStore.setState({
    byThreadKey: {},
    voiceOpen: false,
    voiceActive: false,
    visibleThreadKey: "env-1:thread-A",
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  useDiffPanelStore.setState({
    byThreadKey: {},
    branchBaseRefByThreadKey: {},
  });
}

it("treats Diff saved behind Voice as closed, so opening a turn keeps its selection", async () => {
  reset();
  const store = useRightPanelStore.getState();
  // Diff is the thread's saved, active tab, but the app-wide Voice surface is what is on screen.
  store.open(ref, "diff");
  store.setVoiceOpen(true);

  await using screen = await render(<Harness />, {
    // Nothing here navigates; the harness only calls panel actions.
    router: false,
  });
  await screen.getByRole("button", { name: "Open turn diff" }).click();

  expect(useRightPanelStore.getState().voiceActive).toBe(false);
  expect(useDiffPanelStore.getState().byThreadKey["env-1:thread-A"]).toMatchObject({
    kind: "turn",
    turnId: "turn-1",
  });
});

it("keeps the requested tool diff when Diff was not on screen", async () => {
  reset();

  await using screen = await render(<Harness />, {
    // Nothing here navigates; the harness only calls panel actions.
    router: false,
  });
  await screen.getByRole("button", { name: "Open tool diff" }).click();

  expect(useRightPanelStore.getState().voiceActive).toBe(false);
  expect(useDiffPanelStore.getState().byThreadKey["env-1:thread-A"]).toMatchObject({
    kind: "tool-call",
    itemId: "item-1",
  });
});
