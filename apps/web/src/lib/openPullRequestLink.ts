import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent } from "react";

import {
  resolveChangeRequestLinkTarget,
  resolvePullRequestPreviewTarget,
} from "@t3tools/client-runtime/change-request-links";

import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, useProjects } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { readPrimaryEnvironmentId } from "../state/environments";

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig !== null,
    url,
  });
}

function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

// Read at click time: every provider status push replaces the config map, and subscribing
// would hand every rendered link a new handler. Projects likewise, so a link can resolve
// against a snapshot that arrived after this handler was built.
function readChangeRequestLinkTarget(
  url: string,
  environmentId: EnvironmentId | undefined,
  lendHostProject: boolean,
) {
  const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
  return resolveChangeRequestLinkTarget({
    url,
    projects: readProjects(),
    configLoaded: (candidate) => serverConfigs.has(candidate),
    ...(environmentId === undefined ? {} : { environmentId }),
    primaryEnvironmentId: readPrimaryEnvironmentId(),
    lendHostProject,
  });
}

function openChangeRequestInPanel(input: {
  readonly panelRef: ScopedThreadRef;
  readonly target: NonNullable<ReturnType<typeof readChangeRequestLinkTarget>>;
  readonly url: string;
}) {
  const { project, repository, number, host } = input.target;
  useRightPanelStore.getState().openPullRequest(input.panelRef, {
    // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
    ...(input.panelRef.environmentId === project.environmentId
      ? {}
      : { environmentId: project.environmentId }),
    projectId: project.id,
    ...(host === undefined ? {} : { host }),
    repository,
    url: input.url,
    number,
  });
}

/** Opens a link's pull request in the thread's right panel, whatever the link setting says. */
export function openChangeRequestInRightPanel(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
}): boolean {
  const target = readChangeRequestLinkTarget(input.url, input.threadRef.environmentId, true);
  if (target === null) return false;
  openChangeRequestInPanel({ panelRef: input.threadRef, target, url: input.url });
  return true;
}

export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
    if (!openInApp || shouldOpenPullRequestExternally(event)) return false;
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const resolvedPanelRef = panelRef ?? resolvedThreadRef;
    const target = readChangeRequestLinkTarget(
      targetUrl,
      resolvedThreadRef?.environmentId ?? targetEnvironmentId,
      resolvedPanelRef !== undefined,
    );
    if (target === null) return false;
    const { project, repository, number, host } = target;
    event.preventDefault();
    event.stopPropagation();
    const pullRequestsSearch = {
      repository,
      number,
      ...(host === undefined ? {} : { selectedHost: host }),
      selectedProjectId: project.id,
      selectedEnvironmentId: project.environmentId,
    };
    if (resolvedPanelRef) {
      openChangeRequestInPanel({ panelRef: resolvedPanelRef, target, url: targetUrl });
      if (!resolvedThreadRef) {
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            involvement: previous.involvement ?? "all",
            state: previous.state ?? "all",
            ...pullRequestsSearch,
          }),
          replace: true,
        });
      }
      return true;
    }
    void navigate({
      to: "/pull-requests",
      search: { involvement: "all", state: "all", ...pullRequestsSearch },
    });
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // Native links handle modified clicks; buttons still need openExternal.
    if (openInBrowser && isAnchor) return false;

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

    void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
    return false;
  };
}
