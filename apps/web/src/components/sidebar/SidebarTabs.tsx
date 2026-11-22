import { useDroppable } from "@dnd-kit/core";
import { useGT } from "gt-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { sidebarSectionDropId } from "../Sidebar.logic";

export type SidebarTab = "idle" | "working" | "snoozed";

export const SIDEBAR_TABS: readonly SidebarTab[] = ["idle", "working", "snoozed"];
/** Without the Working shelf, working threads stay in Idle. */
export const SIDEBAR_TABS_WITHOUT_WORKING: readonly SidebarTab[] = ["idle", "snoozed"];

export function sidebarTabPanelId(tab: SidebarTab) {
  return `sidebar-tabpanel-${tab}`;
}

export function sidebarTabElementId(tab: SidebarTab) {
  return `sidebar-tab-${tab}`;
}

/** The Idle | Working | Snoozed switcher above the sidebar footer. */
export function SidebarTabs(props: {
  tabs: readonly SidebarTab[];
  value: SidebarTab;
  counts: { readonly working: number; readonly snoozed: number };
  onValueChange: (tab: SidebarTab) => void;
}) {
  const gt = useGT();
  const buttons = useRef(new Map<SidebarTab, HTMLButtonElement | null>());
  const idleDrop = useDroppable({ id: sidebarSectionDropId("active") });
  const [pill, setPill] = useState<{ readonly left: number; readonly width: number } | null>(null);
  const labels: Record<SidebarTab, string> = {
    idle: gt("Idle", { $context: "sidebar tab" }),
    working: gt("Working", { $context: "sidebar section" }),
    snoozed: gt("Snoozed", { $context: "sidebar section" }),
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the selected tab so the raised pill can slide under it
  useLayoutEffect(() => {
    const measure = () => {
      const selected = buttons.current.get(props.value);
      if (!selected) return;
      const next = { left: selected.offsetLeft, width: selected.offsetWidth };
      setPill((current) =>
        current !== null && current.left === next.left && current.width === next.width
          ? current
          : next,
      );
    };
    measure();
    // Dragging the sidebar edge moves the tabs under a standing pill.
    const track = buttons.current.get(props.value)?.parentElement;
    return track ? observeResize(track, measure) : undefined;
  }, [props.value]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, direction: 1 | -1 | "first" | "last") => {
    const { tabs } = props;
    const index = tabs.indexOf(props.value);
    const next =
      direction === "first"
        ? tabs[0]
        : direction === "last"
          ? tabs[tabs.length - 1]
          : tabs[(index + direction + tabs.length) % tabs.length];
    if (next === undefined) return;
    event.preventDefault();
    props.onValueChange(next);
    buttons.current.get(next)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={gt("Thread lists")}
      data-sidebar-tabs=""
      className="relative mx-(--sidebar-content-inset) my-1 flex h-[30px] shrink-0 items-stretch rounded-(--sidebar-switch-radius) bg-sidebar-control-surface p-0.5"
    >
      {pill ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0.5 bottom-0.5 rounded-(--sidebar-switch-pill-radius) bg-sidebar-row-active shadow-sm ring-1 ring-sidebar-border transition-[left,width] duration-(--sidebar-slide-duration) ease-(--ease-sidebar-slide) motion-reduce:transition-none"
          style={{ left: pill.left, width: pill.width }}
        />
      ) : null}
      {props.tabs.map((tab) => {
        const selected = tab === props.value;
        const count = tab === "idle" ? null : props.counts[tab];
        return (
          <button
            key={tab}
            ref={(element) => {
              buttons.current.set(tab, element);
              if (tab === "idle") idleDrop.setNodeRef(element);
            }}
            type="button"
            role="tab"
            id={sidebarTabElementId(tab)}
            aria-selected={selected}
            aria-controls={sidebarTabPanelId(tab)}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onValueChange(tab)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") move(event, 1);
              else if (event.key === "ArrowLeft") move(event, -1);
              else if (event.key === "Home") move(event, "first");
              else if (event.key === "End") move(event, "last");
            }}
            className={cn(
              "relative z-1 flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-(--sidebar-switch-pill-radius) text-xs outline-none text-sidebar-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selected && "font-medium text-sidebar-foreground",
              tab === "idle" &&
                idleDrop.isOver &&
                "bg-primary/5 text-primary ring-1 ring-primary/40",
            )}
          >
            <span className="truncate">{labels[tab]}</span>
            {count === null ? null : (
              <span className="shrink-0 font-normal tabular-nums text-sidebar-muted-foreground/75">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
