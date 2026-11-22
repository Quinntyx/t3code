import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { sidebarTabElementId, sidebarTabPanelId, type SidebarTab } from "./SidebarTabs";

const SIDEBAR_TABS: readonly SidebarTab[] = ["idle", "working", "snoozed"];
const SIDEBAR_SLIDE_MS = 320;

function indexOf(tab: SidebarTab) {
  return SIDEBAR_TABS.indexOf(tab);
}

/** Three columns on one track. Only the current and outgoing lists stay mounted during a slide. */
export function SidebarTrack(props: {
  active: SidebarTab;
  columns: Record<SidebarTab, ReactNode>;
}) {
  const target = indexOf(props.active);
  const [view, setView] = useState<{
    readonly current: SidebarTab;
    readonly outgoing: SidebarTab | null;
    readonly position: number;
  }>({ current: props.active, outgoing: null, position: target });
  const previous = useRef(props.active);
  const frame = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the slide at the old column, then moves it on the next frame
  useLayoutEffect(() => {
    if (props.active === previous.current) return;
    const from = previous.current;
    previous.current = props.active;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (timer.current !== null) clearTimeout(timer.current);
    setView({ current: props.active, outgoing: from, position: indexOf(from) });
    frame.current = requestAnimationFrame(() => {
      setView((current) => ({ ...current, position: target }));
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setView((current) => ({ ...current, outgoing: null }));
        return;
      }
      timer.current = window.setTimeout(() => {
        setView((current) => ({ ...current, outgoing: null }));
      }, SIDEBAR_SLIDE_MS);
    });
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [props.active, target]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        className="flex h-full w-[300%] transition-transform duration-(--sidebar-slide-duration) ease-(--ease-sidebar-slide) motion-reduce:transition-none"
        style={{ transform: `translateX(calc(-100% / 3 * ${view.position}))` }}
      >
        {SIDEBAR_TABS.map((tab) => {
          const hidden = tab !== view.current;
          const mounted = tab === view.current || tab === view.outgoing;
          return (
            <div
              key={tab}
              id={sidebarTabPanelId(tab)}
              role="tabpanel"
              aria-labelledby={sidebarTabElementId(tab)}
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              data-sidebar-column={tab}
              className={cn(
                "h-full w-1/3 min-w-0 shrink-0 scrollbar-none overflow-y-auto",
                hidden && "pointer-events-none",
              )}
            >
              {mounted ? props.columns[tab] : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
