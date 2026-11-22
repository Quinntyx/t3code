import type { EnvironmentId, ProjectScript, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { useGT } from "gt-react";
import { PlayIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadShell } from "~/state/entities";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import {
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  ThreadPullRequestBadgeControl,
  useLinkedThreadPullRequest,
} from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Separator } from "../ui/separator";
import { resolveThreadDetailsVisibility } from "./threadDetailsItems";

export interface HeaderWorkspaceActionsProps {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  hasProject: boolean;
  gitCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  draftId?: DraftId | undefined;
  onOpenChanges: (() => void) | undefined;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

/**
 * Run with its scripts, changed files and the git split, in the chat header (layout
 * `workspaceActions: "header"`). The details card's item preferences decide what shows.
 */
export function HeaderWorkspaceActions({
  environmentId,
  threadRef,
  hasProject,
  gitCwd,
  activeProjectScripts,
  preferredScriptId,
  draftId,
  onOpenChanges,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: HeaderWorkspaceActionsProps) {
  const gt = useGT();
  const detailsVisible = useClientSettings(resolveThreadDetailsVisibility);
  const showScripts = activeProjectScripts !== undefined && detailsVisible.scripts;
  const showGit =
    gitCwd !== null && hasProject && (detailsVisible.changes || detailsVisible.gitActions);
  const fileScripts = useT3ProjectFileScripts(environmentId, showScripts ? gitCwd : null);
  const scriptsControlProps = {
    environmentId,
    scripts: activeProjectScripts ?? [],
    fileScripts,
    preferredScriptId,
    onRunScript: onRunProjectScript,
    onAddScript: onAddProjectScript,
    onUpdateScript: onUpdateProjectScript,
    onDeleteScript: onDeleteProjectScript,
  };
  return (
    <div className="ms-auto flex shrink-0 items-center gap-1.5" data-chat-header-actions>
      <div className="hidden items-center gap-1.5 @lg/header-actions:flex">
        {showScripts ? <ProjectScriptsControl {...scriptsControlProps} /> : null}
      </div>
      {showScripts ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={gt("Script actions")}
                className="@lg/header-actions:hidden"
              />
            }
          >
            <PlayIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <ProjectScriptsControl presentation="menu" {...scriptsControlProps} />
          </MenuPopup>
        </Menu>
      ) : null}
      {showGit ? (
        <>
          {showScripts ? (
            <span aria-hidden className="mx-0.5 flex h-4">
              <Separator orientation="vertical" />
            </span>
          ) : null}
          <GitActionsControl
            displayMode="toolbar"
            showActions={detailsVisible.gitActions}
            showChanges={detailsVisible.changes}
            gitCwd={gitCwd}
            activeThreadRef={threadRef}
            {...(draftId !== undefined ? { draftId } : {})}
            {...(onOpenChanges !== undefined ? { onOpenChanges } : {})}
          />
        </>
      ) : null}
    </div>
  );
}

/** The thread's current pull request beside its title, with "+N" when more are linked. */
export function HeaderPullRequestChip({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const serverThread = useQuietThreadShell(threadRef);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(environmentId);
  const linked = useLinkedThreadPullRequest(
    environmentId,
    serverThread?.linkedPullRequest,
    true,
    serverThread?.pullRequests,
    serverThread?.branchPullRequest,
  );
  const currentLink = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(serverThread?.pullRequests ?? [])
    : null;
  const badge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(serverThread?.pullRequests)
    : null;
  const pr = linked?.pr ?? null;
  const number = currentLink?.number ?? pr?.number;
  const url = currentLink?.url ?? pr?.url;
  const openPrLink = useOpenPrLink(threadRef);
  if (number === undefined || url === undefined) return null;
  return (
    <ThreadPullRequestBadgeControl
      render={<Button variant="secondary" size="xs" data-chat-header-pr-chip="" />}
      display="primary-with-count"
      badge={badge}
      pullRequests={serverThread?.pullRequests ?? []}
      number={number}
      url={url}
      status={prStatusIndicator(pr, linked?.sourceControlProvider)}
      onOpenList={() => useRightPanelStore.getState().open(threadRef, "pull-requests")}
      onOpenPullRequest={(event, targetUrl = url) => {
        if (targetUrl) openPrLink(event, targetUrl);
      }}
    />
  );
}
