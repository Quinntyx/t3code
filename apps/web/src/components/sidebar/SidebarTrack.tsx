import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { sidebarTabElementId, sidebarTabPanelId, type SidebarTab } from "./SidebarTabs";

/** One column per tab on one track. Only the current and outgoing lists stay mounted during a slide. */
export function SidebarTrack(props: {
  tabs: readonly SidebarTab[];
  active: SidebarTab;
  columns: Record<SidebarTab, ReactNode>;
}) {
  const indexOf = (tab: SidebarTab) => props.tabs.indexOf(tab);
  const target = indexOf(props.active);
  const [view, setView] = useState<{
    readonly current: SidebarTab;
    readonly outgoing: SidebarTab | null;
    readonly position: number;
  }>({ current: props.active, outgoing: null, position: target });
  const previous = useRef(props.active);
  const frame = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const finishSlide = () => setView((current) => ({ ...current, outgoing: null }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the slide at the old column, then moves it on the next frame
  useLayoutEffect(() => {
    if (props.active === previous.current) return;
    const from = previous.current;
    previous.current = props.active;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    setView({ current: props.active, outgoing: from, position: props.tabs.indexOf(from) });
    frame.current = requestAnimationFrame(() => {
      setView((current) => ({ ...current, position: target }));
      // The theme sets the slide's length; with none (or reduced motion) no transitionend comes.
      const style = trackRef.current ? getComputedStyle(trackRef.current) : null;
      const slides =
        style !== null &&
        style.transitionProperty !== "none" &&
        Number.parseFloat(style.transitionDuration) > 0;
      if (!slides) setView((current) => ({ ...current, outgoing: null }));
    });
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [props.active, props.tabs, target]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={trackRef}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "transform")
            finishSlide();
        }}
        className="flex h-full transition-transform duration-(--sidebar-slide-duration) ease-(--ease-sidebar-slide) motion-reduce:transition-none"
        style={{
          width: `${props.tabs.length * 100}%`,
          transform: `translateX(calc(-100% / ${props.tabs.length} * ${view.position}))`,
        }}
      >
        {props.tabs.map((tab) => {
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
                "h-full min-w-0 shrink-0 scrollbar-none overflow-y-auto",
                hidden && "pointer-events-none",
              )}
              style={{ width: `${100 / props.tabs.length}%` }}
            >
              {mounted ? props.columns[tab] : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
