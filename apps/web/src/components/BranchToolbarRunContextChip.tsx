import type { EnvironmentMachineKind } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
} from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { useRef, type ComponentProps, type MouseEvent, type ReactNode } from "react";

import type { AddProjectTarget } from "../hooks/useAddProjectTargets";
import { useEnvironment } from "../state/environments";
import {
  ADD_TO_MACHINE_LABEL_CLASS,
  resolveMachineConnectionDetail,
  type EnvironmentOption,
} from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface RunContextMachine {
  readonly kind: EnvironmentMachineKind;
  readonly label: string;
  readonly connection: string;
}

export interface RunContextWorkspace {
  readonly kind: "worktree" | "checkout" | "local";
  readonly label: string;
  readonly path: string | null;
}

/** What the chip's popover shows: the facts, the handoff targets, or the branch picker. */
export type RunContextChipView = "info" | "move" | "branch";

const ROW_CLASS =
  "flex min-h-8 w-full items-center gap-2 rounded-glass-item px-2 text-left text-sm";
const ROW_BUTTON_CLASS =
  "group/row cursor-pointer outline-none hover:bg-accent-glass focus-visible:bg-accent-glass";
const ROW_ICON_CLASS = "flex shrink-0 text-muted-foreground opacity-80 [&>svg]:size-4";

/**
 * The started thread's run context as one chip. Its machine, workspace and branch are facts, so the
 * popover states each on one row and ends the row with what can be done about it.
 */
export function BranchToolbarRunContextChip({
  machine,
  workspace,
  branchName,
  branchDetail,
  prSummary,
  prAction,
  showGitControls,
  canMove,
  moveBusy,
  moveDisabled,
  moveTargets,
  addTargets,
  onMoveTo,
  onAddToMachine,
  onCopyWorkspacePath,
  workspaceOpenIn,
  open,
  view,
  onOpenChange,
  onViewChange,
  branchPicker,
  ariaLabel,
  tooltip,
  onContextMenu,
}: {
  machine: RunContextMachine;
  workspace: RunContextWorkspace;
  branchName: string | null;
  branchDetail: string | null;
  prSummary: string | null;
  /** The thread's PR badge, so its glyph, count and menu stay reachable under the branch row. */
  prAction?: ReactNode;
  showGitControls: boolean;
  canMove: boolean;
  moveBusy: boolean;
  moveDisabled: boolean;
  moveTargets: readonly EnvironmentOption[];
  addTargets: readonly AddProjectTarget[];
  onMoveTo: (environmentId: string) => void;
  onAddToMachine: (environmentId: string | null) => void;
  onCopyWorkspacePath: () => void;
  /** Opens the workspace in an editor, so the editor stays reachable from the run context. */
  workspaceOpenIn?: ReactNode;
  open: boolean;
  view: RunContextChipView;
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: RunContextChipView) => void;
  /** The shipped branch picker, rendered in the popover in place of the fact rows. */
  branchPicker: ReactNode;
  ariaLabel: string;
  tooltip: string;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const gt = useGT();
  const floatingLayerProps = useComposerMenuProps();
  const bodyRef = useRef<HTMLDivElement>(null);
  const WorkspaceIcon =
    workspace.kind === "worktree"
      ? FolderGit2Icon
      : workspace.kind === "checkout"
        ? FolderGitIcon
        : FolderIcon;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size="row"
                  className="min-w-0 shrink"
                  data-composer-context-control
                  data-composer-shortcut="composer.host"
                  data-run-context-chip
                  aria-label={ariaLabel}
                  onContextMenu={onContextMenu}
                />
              }
            />
          }
        >
          <EnvironmentMachineIcon kind={machine.kind} className="size-3" />
          <span aria-hidden className="text-icon-muted">
            /
          </span>
          <WorkspaceIcon aria-hidden className="size-3" />
          {branchName ? <span className="max-w-45 truncate">{branchName}</span> : null}
          <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="top"
        align="start"
        padding="none"
        aria-label={gt("Run context")}
        className="w-88 max-w-[calc(100vw-2rem)]"
        // composer.branch opens straight to the picker, where typing should already filter.
        initialFocus={() => (view === "branch" ? searchField(bodyRef.current) : null) ?? true}
        {...floatingLayerProps}
      >
        <div ref={bodyRef} className="flex flex-col p-1.5">
          {view === "branch" ? (
            <>
              <ViewHeader onBack={() => onViewChange("info")}>
                <T>Switch branch</T>
              </ViewHeader>
              <div ref={focusSearchField} className="flex min-h-0 flex-col">
                {branchPicker}
              </div>
            </>
          ) : view === "move" ? (
            <>
              <ViewHeader onBack={() => onViewChange("info")}>
                <T>Move thread to machine</T>
              </ViewHeader>
              <p className="px-2 pb-1.5 text-muted-foreground text-xs leading-relaxed">
                <T>
                  Continues this thread on the other machine in a new worktree. This copy stays as
                  it is.
                </T>
              </p>
              {moveBusy ? (
                <div className={cn(ROW_CLASS, "text-muted-foreground")}>
                  <Spinner size="md" />
                  <T>Moving thread…</T>
                </div>
              ) : (
                <>
                  {moveTargets.map((target) => (
                    <MoveTargetRow
                      key={target.environmentId}
                      target={target}
                      onMove={() => {
                        onOpenChange(false);
                        onMoveTo(target.environmentId);
                      }}
                    />
                  ))}
                  <div aria-current="true" className={ROW_CLASS}>
                    <span className={ROW_ICON_CLASS}>
                      <EnvironmentMachineIcon kind={machine.kind} />
                    </span>
                    <MachineText label={machine.label} detail={machine.connection} />
                    <span className="shrink-0 text-muted-foreground text-xs">
                      <T>Current</T>
                    </span>
                  </div>
                  {addTargets.length > 0 ? (
                    <>
                      <div className="mx-2 my-1 h-px bg-border" />
                      {addTargets.map((target) => (
                        <button
                          key={target.environmentId}
                          type="button"
                          className={cn(ROW_CLASS, ROW_BUTTON_CLASS)}
                          onClick={() => {
                            onOpenChange(false);
                            onAddToMachine(target.environmentId);
                          }}
                        >
                          <span
                            className={cn(
                              ADD_TO_MACHINE_LABEL_CLASS,
                              "gap-2 group-hover/row:opacity-100 group-focus-visible/row:opacity-100",
                            )}
                          >
                            <PlusIcon aria-hidden className="size-4 shrink-0" />
                            <span className="min-w-0 truncate">
                              <T>
                                Add to <Var>{target.label}</Var>
                              </T>
                            </span>
                          </span>
                        </button>
                      ))}
                    </>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <>
              <FactRow
                label={gt("Machine")}
                icon={<EnvironmentMachineIcon kind={machine.kind} />}
                action={
                  canMove ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={moveBusy || moveDisabled}
                            onClick={() => onViewChange("move")}
                          />
                        }
                      >
                        {moveBusy ? <Spinner /> : null}
                        <T>Move…</T>
                      </TooltipTrigger>
                      <TooltipPopup>
                        <T>Move this thread to another machine</T>
                      </TooltipPopup>
                    </Tooltip>
                  ) : null
                }
              >
                <MachineText label={machine.label} detail={machine.connection} />
              </FactRow>
              <FactRow
                label={gt("Workspace")}
                icon={<WorkspaceIcon aria-hidden />}
                action={
                  <span className="flex items-center gap-0.5">
                    {workspaceOpenIn}
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost-muted"
                            size="icon-xs"
                            aria-label={gt("Copy full path")}
                            disabled={workspace.path === null}
                            onClick={onCopyWorkspacePath}
                          />
                        }
                      >
                        <CopyIcon aria-hidden />
                      </TooltipTrigger>
                      <TooltipPopup>
                        <T>Copy full path</T>
                      </TooltipPopup>
                    </Tooltip>
                  </span>
                }
              >
                <span className="shrink-0">{workspace.label}</span>
                {workspace.path ? (
                  <span className="flex min-w-0 font-mono text-2xs text-muted-foreground">
                    <MiddleTruncate value={workspace.path} />
                  </span>
                ) : null}
              </FactRow>
              {showGitControls ? (
                <>
                  <FactRow
                    label={gt("Branch")}
                    icon={<GitBranchIcon aria-hidden />}
                    action={
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => onViewChange("branch")}
                            />
                          }
                        >
                          <T>Switch…</T>
                        </TooltipTrigger>
                        <TooltipPopup>
                          <T>Switch branch</T>
                        </TooltipPopup>
                      </Tooltip>
                    }
                  >
                    <MiddleTruncate value={branchName ?? gt("No branch")} />
                  </FactRow>
                  <BranchStatus detail={branchDetail} prSummary={prSummary} prAction={prAction} />
                </>
              ) : null}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function searchField(container: HTMLElement | null) {
  return container?.querySelector<HTMLInputElement>("input") ?? null;
}

/** Entering the picker from the facts lands on its search field, as the picker's own popup does. */
function focusSearchField(container: HTMLElement | null) {
  searchField(container)?.focus({ preventScroll: true });
}

/** The branch's standing against its upstream, then its pull request, on one line under the name. */
function BranchStatus({
  detail,
  prSummary,
  prAction,
}: {
  detail: string | null;
  prSummary: string | null;
  prAction: ReactNode;
}) {
  if (detail === null && prSummary === null && !prAction) return null;
  return (
    <div className="flex min-h-7 items-center gap-2 ps-8 pe-2 text-muted-foreground text-xs">
      <span className="flex min-w-0 flex-1">
        {detail ? <span className="shrink-0">{detail}</span> : null}
        {detail && prSummary ? <span className="shrink-0 whitespace-pre"> · </span> : null}
        {prSummary ? (
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 truncate" />}>
              {prSummary}
            </TooltipTrigger>
            <TooltipPopup>{prSummary}</TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
      {prAction}
    </div>
  );
}

/** A machine's name, then how it is reached. The name keeps its width; the route gives way. */
function MachineText({ label, detail }: { label: string; detail: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="max-w-[65%] shrink-0 truncate">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground text-xs">{detail}</span>
    </span>
  );
}

function MoveTargetRow({ target, onMove }: { target: EnvironmentOption; onMove: () => void }) {
  const presentation = useEnvironment(target.environmentId);
  const detail = resolveMachineConnectionDetail({
    isPrimary: target.isPrimary,
    relayManaged: presentation?.relayManaged ?? false,
    displayUrl: presentation?.displayUrl ?? null,
    connectionPhase: presentation?.connection.phase ?? "connected",
  });
  return (
    <button type="button" className={cn(ROW_CLASS, ROW_BUTTON_CLASS)} onClick={onMove}>
      <span className={ROW_ICON_CLASS}>
        <EnvironmentMachineIcon kind={target.machine} />
      </span>
      <MachineText label={target.label} detail={detail} />
    </button>
  );
}

function ViewHeader({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  const gt = useGT();
  return (
    <div className="flex h-8 items-center gap-1 px-1 font-medium text-sm">
      <Button variant="ghost-muted" size="icon-xs" aria-label={gt("Back")} onClick={onBack}>
        <ChevronLeftIcon aria-hidden />
      </Button>
      {children}
    </div>
  );
}

function FactRow({
  label,
  icon,
  action,
  children,
}: {
  label: string;
  icon: ReactNode;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="flex min-h-8 items-center gap-2 px-2 text-sm">
      <span className={ROW_ICON_CLASS}>{icon}</span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">{children}</div>
      {action}
    </div>
  );
}

/** The popover's quiet inline action; the PR badge renders through it to sit under the branch row. */
export function RunContextRowButton({
  icon: _icon,
  ...props
}: ComponentProps<typeof Button> & { icon?: boolean }) {
  // ghost-muted leaves the glyph on currentColor, so the PR badge keeps its state colour.
  return <Button variant="ghost-muted" size="xs" {...props} />;
}
