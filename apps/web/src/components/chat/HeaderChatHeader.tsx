import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectScript,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, Var } from "gt-react";
import { ChevronDownIcon, PlayIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Separator } from "../ui/separator";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { textDirection } from "~/textDirection";
import { useClientSettings } from "../../hooks/useSettings";
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
import { GuestShareIndicator } from "./GuestShareControls";
import type { DraftId } from "../../composerDraftStore";
import { resolveThreadDetailsVisibility } from "./threadDetailsItems";

export interface HeaderChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
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

function resolveHeaderRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export function HeaderChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isServerThread,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
  onFindInThread,
  gitCwd,
  activeProjectScripts,
  preferredScriptId,
  draftId,
  onOpenChanges,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: HeaderChatHeaderProps) {
  const gt = useGT();
  const activeProjectName = activeProject?.isScratch ? gt("No project") : activeProject?.title;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const detailsVisible = useClientSettings(resolveThreadDetailsVisibility);
  const showScripts = activeProjectScripts !== undefined && detailsVisible.scripts;
  const showGit =
    gitCwd !== null &&
    activeProjectName !== undefined &&
    (detailsVisible.changes || detailsVisible.gitActions);
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts !== undefined ? gitCwd : null,
  );

  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the breadcrumb list DOM via ResizeObserver, a frame and font loads to collapse the parent title
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    activeThreadTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveHeaderRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: gt("Thread title cannot be empty") });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Failed to rename thread"),
          description: error instanceof Error ? error.message : gt("An error occurred."),
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProject?.workspaceRoot ?? null,
    onStartRename: startRename,
    onFind: onFindInThread,
    canShareWithGuest,
  });
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: gt("Project settings"), icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };

  const headerActions = (
    <div className="flex shrink-0 items-center gap-1.5" data-chat-header-actions>
      <div className="hidden items-center gap-1.5 @lg/header-actions:flex">
        {showScripts ? (
          <ProjectScriptsControl
            environmentId={activeThreadEnvironmentId}
            scripts={activeProjectScripts!}
            fileScripts={fileScripts}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        ) : null}
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
            <ProjectScriptsControl
              presentation="menu"
              environmentId={activeThreadEnvironmentId}
              scripts={activeProjectScripts!}
              fileScripts={fileScripts}
              preferredScriptId={preferredScriptId}
              onRunScript={onRunProjectScript}
              onAddScript={onAddProjectScript}
              onUpdateScript={onUpdateProjectScript}
              onDeleteScript={onDeleteProjectScript}
            />
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
            activeThreadRef={activeThreadRef}
            {...(draftId !== undefined ? { draftId } : {})}
            {...(onOpenChanges !== undefined ? { onOpenChanges } : {})}
          />
        </>
      ) : null}
    </div>
  );

  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn(
        "@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceBreadcrumb
          ariaLabel={gt("Thread breadcrumb")}
          className="overflow-clip [overflow-clip-margin:2px]"
        >
          {activeProject ? (
            <>
              <WorkspaceBreadcrumbItem className="hidden shrink @2xl/header-actions:flex">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={gt("New thread in {project}", { project: activeProjectName })}
                        onClick={onNewThreadInProject}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    <MiddleTruncate
                      data-slot="workspace-breadcrumb-text"
                      value={activeProjectName ?? ""}
                      showTitle={false}
                      variant="cap-aligned"
                      className="max-w-40"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <T>
                      New thread in <Var>{activeProjectName}</Var>
                    </T>
                  </TooltipPopup>
                </Tooltip>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator className="hidden @2xl/header-actions:flex">
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          ) : null}
          {parentThreadLink ? (
            <>
              <WorkspaceBreadcrumbItem>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={gt("Open parent thread: {title}", {
                          title: parentThreadLink.title,
                        })}
                        onClick={() => onOpenThread(parentThreadLink.threadId)}
                        className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      />
                    }
                  >
                    <WorkspaceBreadcrumbText
                      aria-hidden
                      className={collapseParentTitle ? "w-0" : undefined}
                    >
                      {parentThreadLink.title}
                    </WorkspaceBreadcrumbText>
                    {collapseParentTitle ? (
                      <span aria-hidden data-parent-breadcrumb-ellipsis>
                        ...
                      </span>
                    ) : null}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
                </Tooltip>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          ) : null}
          <WorkspaceBreadcrumbItem current className="min-w-10">
            {renamingTitle !== null ? (
              <input
                autoFocus
                dir="auto"
                aria-label={gt("Thread title")}
                className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
                defaultValue={renamingTitle}
                onBlur={(event) => {
                  if (renameCommittedRef.current) return;
                  if (
                    event.relatedTarget instanceof HTMLElement &&
                    event.relatedTarget.closest("button")
                  ) {
                    setRenaming(null);
                    return;
                  }
                  commitRename(event.currentTarget.value);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={handleRenameKeyDown}
              />
            ) : isServerThread ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={gt("Thread actions for {title}", { title: activeThreadTitle })}
                      aria-haspopup="menu"
                      onClick={openMenuFromTitle}
                      onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                      className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <h2 className="min-w-0" dir={textDirection(activeThreadTitle)}>
                    <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
                  </h2>
                  <ChevronDownIcon
                    aria-hidden
                    data-thread-title-chevron
                    className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                  />
                </TooltipTrigger>
                <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <h2
                      aria-label={activeThreadTitle}
                      className="min-w-0 flex-1"
                      dir={textDirection(activeThreadTitle)}
                    />
                  }
                >
                  <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
              </Tooltip>
            )}
            {renamingTitle === null && activeThreadLinkOrigin ? (
              <Tooltip>
                <TooltipTrigger render={<Badge variant="info" size="sm" />}>
                  <T>
                    From <Var>{activeThreadLinkOrigin}</Var>
                  </T>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <T>
                    Started by an agent on <Var>{activeThreadLinkOrigin}</Var> through a linked
                    environment.
                  </T>
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {isServerThread && renamingTitle === null ? (
          <HeaderPullRequestChip
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
          />
        ) : null}
        {isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null}
      </div>
      {headerActions}
    </div>
  );
}

function HeaderPullRequestChip({
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
