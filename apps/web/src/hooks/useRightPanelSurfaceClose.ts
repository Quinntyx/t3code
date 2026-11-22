import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { getTerminalLabel } from "@t3tools/shared/terminalLabelsCopy";
import { agentControlledBrowserCloseConfirmation } from "../components/ChatView.logic";
import { closePreviewSession } from "../components/preview/closePreviewSession";
import { useThreadTerminalActions } from "../components/terminal/useThreadTerminalActions";
import { m } from "../i18n/messages";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { focusPanelTerminalAfterClose } from "../lib/terminalFocus";
import { readLocalApi } from "../localApi";
import { setActivePreviewTab, useThreadPreviewState } from "../previewStateStore";
import {
  bulkCloseTargets,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useStableCallback } from "./useStableCallback";

/**
 * Closing releases preview and terminal sessions, and deletes a side chat that never ran.
 * Agent-driven browsers and terminal tabs require confirmation.
 */
export function useRightPanelSurfaceClose(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  /** The tabs the panel displays, Voice included; bulk closes order and filter against these. */
  readonly displayedSurfaces: ReadonlyArray<RightPanelSurface>;
}) {
  const { threadRef, terminalLabelsById, displayedSurfaces } = input;
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const deleteThread = useAtomCommand(threadEnvironment.delete, "side chat delete");
  const canOperatePreview = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const previewState = useThreadPreviewState(threadRef);
  const terminalActions = useThreadTerminalActions(threadRef);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);

  const releaseSurfaceResources = (ref: ScopedThreadRef, surface: RightPanelSurface) => {
    // Without preview access, server state remains until an authorized close or restart.
    if (canOperatePreview && surface.kind === "preview" && surface.resourceId) {
      void closePreviewSession({
        closePreview,
        snapshot: previewState.sessions[surface.resourceId] ?? null,
        tabId: surface.resourceId,
        threadRef: ref,
      });
    }
    if (
      surface.kind === "terminal" &&
      readEnvironmentScope(ref.environmentId, AuthTerminalOperateScope)
    ) {
      for (const terminalId of surface.terminalIds) {
        storeCloseTerminal(ref, terminalId);
        terminalActions.closeTerminalSession(terminalId, ref);
      }
    }
    if (
      surface.kind === "side-chat" &&
      readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope) &&
      // A live shell without the side chat means it is already deleted.
      !(
        appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId)).status === "live" &&
        readThreadShell(scopeThreadRef(ref.environmentId, surface.threadId)) === null
      )
    ) {
      // The server keeps a side chat with a run or message. Reopen skips one it deleted.
      void deleteThread({
        environmentId: ref.environmentId,
        input: { threadId: surface.threadId, onlyIfUnused: true },
      });
    }
  };
  const closeAfterAgentBrowserConfirmation = (
    toClose: readonly RightPanelSurface[],
    closeSurfaces: () => void,
  ) => {
    const message = agentControlledBrowserCloseConfirmation(toClose, previewState.desktopByTabId);
    if (!message) {
      closeSurfaces();
      return;
    }
    const localApi = readLocalApi();
    if (!localApi) return;
    void localApi.dialogs.confirm(message, { variant: "destructive" }).then(
      (confirmed) => {
        if (confirmed) closeSurfaces();
      },
      () => undefined,
    );
  };
  // The active surface closes last so the panel does not flash through it.
  const finishClose = (toClose: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    const store = useRightPanelStore.getState();
    const activeId = selectThreadRightPanelState(store.byThreadKey, threadRef).activeSurfaceId;
    const ordered = toClose.toSorted(
      (left, right) => Number(left.id === activeId) - Number(right.id === activeId),
    );
    for (const surface of ordered) {
      // Releasing a browser drops its session, which prunes the tab automatically; close it
      // first so the close stays a user action that hides the panel after the last tab.
      store.closeSurface(threadRef, surface.id);
      releaseSurfaceResources(threadRef, surface);
    }
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(threadRef, nextActiveSurface.resourceId);
    }
    focusPanelTerminalAfterClose(threadRef, activeId);
  };
  const labelFor = (terminalId: string) =>
    terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId, m);
  const closeSurfaces = (toClose: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    closeAfterAgentBrowserConfirmation(toClose, () => {
      const labels = readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
        ? toClose.flatMap((surface) =>
            surface.kind === "terminal" ? surface.terminalIds.map(labelFor) : [],
          )
        : [];
      const [first, ...rest] = labels;
      if (first === undefined) {
        finishClose(toClose);
        return;
      }
      void confirmTerminalClose([first, ...rest]).then((confirmed) => {
        if (confirmed) finishClose(toClose);
      });
    });
  };

  const closeSurface = useStableCallback((surface: RightPanelSurface) => {
    if (!threadRef) return;
    if (surface.kind === "voice") {
      useRightPanelStore.getState().setVoiceOpen(false);
      return;
    }
    if (surface.kind === "preview") {
      closeSurfaces([surface]);
      return;
    }
    if (
      surface.kind !== "terminal" ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    ) {
      finishClose([surface]);
      return;
    }
    const otherLabels = surface.terminalIds
      .filter((terminalId) => terminalId !== surface.activeTerminalId)
      .map(labelFor);
    void confirmTerminalClose([labelFor(surface.activeTerminalId), ...otherLabels]).then(
      (confirmed) => {
        if (confirmed) finishClose([surface]);
      },
    );
  });
  // Bulk closes resolve against the displayed ordering, Voice pinned first, and only ever close
  // this thread's surfaces: the app-wide Voice tab has its own close.
  const closeOtherSurfaces = useStableCallback((surface: RightPanelSurface) =>
    closeSurfaces(bulkCloseTargets(displayedSurfaces, surface.id, "others")),
  );
  const closeSurfacesToRight = useStableCallback((surface: RightPanelSurface) =>
    closeSurfaces(bulkCloseTargets(displayedSurfaces, surface.id, "right")),
  );
  const closeAllSurfaces = useStableCallback(() =>
    closeSurfaces(bulkCloseTargets(displayedSurfaces, "", "all")),
  );

  return { closeSurface, closeOtherSurfaces, closeSurfacesToRight, closeAllSurfaces };
}
