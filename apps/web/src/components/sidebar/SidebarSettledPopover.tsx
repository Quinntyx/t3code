import { useAtomValue } from "@effect/atom-react";
import { useDroppable } from "@dnd-kit/core";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { CheckCheckIcon, ChevronDownIcon, EyeIcon, SearchIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useState, type MouseEvent } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { sidebarSectionDropId } from "../Sidebar.logic";
import { useNowMinute } from "../../hooks/useNowMinute";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarSettledPopover(props: {
  /** The settled threads the shelf lists so far; "Show more" pages older ones in. */
  settledThreads: ReadonlyArray<EnvironmentThreadShell>;
  projectByKey: ReadonlyMap<string, Parameters<typeof ProjectFavicon>[0]["project"]>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  onUnsettle: (thread: EnvironmentThreadShell) => void;
  onOpen: (thread: EnvironmentThreadShell) => void;
  /** The stock thread menu, as on a sidebar row. */
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onOpenChange: (open: boolean) => void;
  /** `count` is how many the next page adds; zero when none are left. */
  showMore: {
    readonly count: number;
    readonly loading: boolean;
    readonly failed: boolean;
    readonly run: () => void;
  };
}) {
  const gt = useGT();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const settledDrop = useDroppable({ id: sidebarSectionDropId("settled") });
  const paletteShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const [open, setOpenState] = useState(false);
  const recent = sortSettledThreads(props.settledThreads);
  const nowMs = Date.parse(useNowMinute());
  const title = gt("Recently settled");
  const setOpen = (next: boolean) => {
    setOpenState(next);
    props.onOpenChange(next);
  };
  const openInPlace = (event: MouseEvent, thread: EnvironmentThreadShell) => {
    event.stopPropagation();
    event.preventDefault();
    setOpen(false);
    props.onOpen(thread);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <SidebarMenuButton
                    ref={(node) => settledDrop.setNodeRef(node)}
                    aria-label={title}
                    data-sidebar-settled-button=""
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    data-drop-target={settledDrop.isOver ? "" : undefined}
                    aria-pressed={settledDrop.isOver || undefined}
                    variant={settledDrop.isOver ? "outline" : "default"}
                    size="icon"
                  >
                    <CheckCheckIcon />
                  </SidebarMenuButton>
                }
              />
            }
          />
          <TooltipPopup side="top">{title}</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>
      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <PopoverTitle className="sr-only">{title}</PopoverTitle>
        <div className="flex flex-col gap-0.5">
          <div className="px-2 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">{title}</div>
          <div className="flex max-h-[min(19rem,var(--available-height,19rem))] flex-col gap-0.5 overflow-y-auto">
            {recent.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {gt("Nothing settled recently")}
              </p>
            ) : (
              recent.map((thread) => {
                const projectKey = `${thread.environmentId}:${thread.projectId}`;
                const project = props.projectByKey.get(projectKey);
                const projectName = props.projectDisplayNameByKey.get(projectKey);
                const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
                const ago = formatRelativeTimeLabel(
                  thread.settledAt ?? thread.updatedAt ?? thread.createdAt,
                  nowMs,
                );
                return (
                  <div
                    key={threadKey}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setOpen(false);
                      props.onContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        { x: event.clientX, y: event.clientY },
                        contextMenuSourceOf(event),
                      );
                    }}
                    className="group/settled-row relative flex h-[34px] shrink-0 items-center gap-2 rounded-md pr-1 pl-2 hover:bg-accent"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        props.onUnsettle(thread);
                      }}
                      aria-label={
                        projectName
                          ? gt("Un-settle {title}, {project}", {
                              title: thread.title,
                              project: projectName,
                            })
                          : gt("Un-settle {title}", { title: thread.title })
                      }
                      className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                    <span className="pointer-events-none relative flex shrink-0 items-center">
                      {project ? <ProjectFavicon project={project} className="size-4" /> : null}
                    </span>
                    <span className="pointer-events-none relative min-w-0 flex-1 truncate-fade text-sm text-sidebar-foreground">
                      {thread.title}
                    </span>
                    <span className="pointer-events-none relative shrink-0 text-xs tabular-nums text-muted-foreground group-focus-within/settled-row:hidden group-hover/settled-row:hidden pointer-coarse:hidden">
                      {ago}
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={gt("Open {title} without un-settling", {
                              title: thread.title,
                            })}
                            onClick={(event) => openInPlace(event, thread)}
                            className={cn(
                              "relative hidden size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-focus-within/settled-row:grid group-hover/settled-row:grid pointer-coarse:grid",
                            )}
                          >
                            <EyeIcon className="size-3.5" />
                          </button>
                        }
                      />
                      <TooltipPopup side="top">{gt("Open without un-settling")}</TooltipPopup>
                    </Tooltip>
                  </div>
                );
              })
            )}
          </div>
          {props.showMore.count > 0 ? (
            <button
              type="button"
              disabled={props.showMore.loading}
              onClick={props.showMore.run}
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default"
            >
              <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
              {props.showMore.loading
                ? gt("Loading")
                : props.showMore.failed
                  ? gt("Could not load older threads. Retry")
                  : gt("Show {count} more", { count: props.showMore.count })}
            </button>
          ) : null}
          <div className="mx-1.5 my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openCommandPalette();
            }}
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <SearchIcon aria-hidden className="size-3.5 shrink-0" />
            {gt("Search all threads")}
            {paletteShortcut ? (
              <span className="ms-auto tabular-nums">{paletteShortcut}</span>
            ) : null}
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
