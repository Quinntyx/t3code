import { scopedThreadKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { Outlet, useMatches } from "@tanstack/react-router";
import { useState } from "react";
import { ThreadRouteView } from "./ThreadRouteView";
import { isAppModalPage } from "./sidebar/mainAppLocation";
import { SidebarInset } from "./ui/sidebar";
import type { ThreadRouteTarget } from "../threadRoutes";
import { ThreadLinkPrompt } from "./promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useDeusPanelStore } from "../deusPanelStore";
import { DeusPanel } from "./deus/DeusPanel";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

export function ChatRouteLayout() {
  const threadTarget = useThreadRouteTarget();
  const deusTarget = useDeusPanelStore((state) => state.target);
  const deusMaximized = useDeusPanelStore((state) => state.maximized);
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget))
    setBackgroundTarget(threadTarget);
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      <div
        className="flex h-dvh min-w-0 flex-1"
        inert={modalOpen || undefined}
        aria-hidden={modalOpen || undefined}
      >
        <div className={deusTarget && deusMaximized ? "hidden" : "flex min-w-0 flex-1"}>
          {shownTarget ? (
            <ThreadRouteView target={shownTarget} background={modalOpen} />
          ) : modalOpen ? (
            <SidebarInset className="h-dvh" />
          ) : (
            <Outlet />
          )}
        </div>
        {deusTarget ? (
          <DeusPanel
            key={scopedProjectKey(deusTarget)}
            target={deusTarget}
            background={modalOpen}
          />
        ) : null}
      </div>
      {modalOpen ? <Outlet /> : null}
    </>
  );
}
