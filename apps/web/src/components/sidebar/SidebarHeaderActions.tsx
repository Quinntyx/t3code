import { useGT } from "gt-react";
import { FolderPlusIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export interface SidebarHeaderActionsProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  threadVisibility?: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
}

/** The search row's icon buttons, right-aligned beside the app name when search is hidden. */
export function SidebarHeaderActions({
  hasProjects,
  projectScope,
  threadVisibility,
  onNewProject,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
}: SidebarHeaderActionsProps) {
  const gt = useGT();
  const newThreadLabel = newThreadShortcutLabel
    ? gt("New thread ({shortcut})", { shortcut: newThreadShortcutLabel })
    : gt("New thread");

  return (
    <div className="flex shrink-0 items-center" data-sidebar-header-actions="">
      {threadVisibility}
      {hasProjects ? (
        <>
          {projectScope}
          <SidebarHeaderIconButton label={gt("Add project")} onClick={onNewProject}>
            <FolderPlusIcon />
          </SidebarHeaderIconButton>
        </>
      ) : null}
      <SidebarHeaderIconButton
        label={gt("New thread")}
        tooltip={
          showNewThreadInProjectHint ? (
            <span className="flex flex-col gap-0.5">
              <span>{newThreadLabel}</span>
              <span className="text-muted-foreground">
                {newThreadInProjectShortcutLabel
                  ? gt("New thread in current project: Shift+click ({shortcut})", {
                      shortcut: newThreadInProjectShortcutLabel,
                    })
                  : gt("New thread in current project: Shift+click")}
              </span>
            </span>
          ) : (
            newThreadLabel
          )
        }
        disabled={newThreadDisabled}
        onClick={onNewThread}
      >
        <SquarePenIcon />
      </SidebarHeaderIconButton>
    </div>
  );
}
