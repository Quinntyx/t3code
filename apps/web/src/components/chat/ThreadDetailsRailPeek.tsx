import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState, type FocusEvent, type TransitionEvent } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { ThreadUsagePanel } from "./ThreadUsagePanel";
import {
  THREAD_DETAILS_RAIL_SECTIONS,
  type ThreadDetailsRailSection,
} from "./threadDetailsRailStore";

type SectionSizes = Readonly<Record<ThreadDetailsRailSection, number>>;

const EMPTY_SIZES: SectionSizes = { usage: 0, agents: 0, sideChats: 0 };

/**
 * The card for the rail section under the pointer. All three sections stay stacked in one column, so
 * moving between them slides the card to the section and scrolls its content to the matching panel.
 */
export function ThreadDetailsRailPeek({
  threadRef,
  section,
  open,
  onClosed,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onEscape,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly section: ThreadDetailsRailSection;
  /** False while the card fades out; it calls onClosed once the fade ends. */
  readonly open: boolean;
  readonly onClosed: () => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onEscape: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const panelRefs = useRef<Partial<Record<ThreadDetailsRailSection, HTMLDivElement | null>>>({});
  const [heights, setHeights] = useState<SectionSizes>(EMPTY_SIZES);
  const [tops, setTops] = useState<SectionSizes>(EMPTY_SIZES);
  const [available, setAvailable] = useState(0);
  // Placement settles before the first paint; motion starts after it, so opening never slides in.
  const [ready, setReady] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the panels' rendered heights and the rail sections' positions to place the card
  useLayoutEffect(() => {
    const card = cardRef.current;
    const dock = card?.offsetParent;
    if (!card || !(dock instanceof HTMLElement)) return;
    const panels = THREAD_DETAILS_RAIL_SECTIONS.flatMap((key) => {
      const panel = panelRefs.current[key];
      return panel ? [panel] : [];
    });
    const measure = () => {
      const dockTop = dock.getBoundingClientRect().top;
      const read = (pick: (key: ThreadDetailsRailSection) => number) =>
        Object.fromEntries(THREAD_DETAILS_RAIL_SECTIONS.map((key) => [key, pick(key)])) as Record<
          ThreadDetailsRailSection,
          number
        >;
      const nextHeights = read((key) => panelRefs.current[key]?.offsetHeight ?? 0);
      const nextTops = read((key) => {
        const anchor = dock.querySelector(`[data-rail-section="${key}"]`);
        return anchor ? Math.round(anchor.getBoundingClientRect().top - dockTop) : 0;
      });
      const same = (a: SectionSizes, b: SectionSizes) =>
        THREAD_DETAILS_RAIL_SECTIONS.every((key) => a[key] === b[key]);
      setHeights((current) => (same(current, nextHeights) ? current : nextHeights));
      setTops((current) => (same(current, nextTops) ? current : nextTops));
      setAvailable(dock.clientHeight);
    };
    measure();
    const frame = requestAnimationFrame(() => setReady(true));
    const stop = observeResize([dock, ...panels], measure);
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, []);

  const index = THREAD_DETAILS_RAIL_SECTIONS.indexOf(section);
  const scrolled = THREAD_DETAILS_RAIL_SECTIONS.slice(0, index).reduce(
    (sum, key) => sum + heights[key],
    0,
  );
  const height = Math.min(heights[section], available);
  const top = Math.max(0, Math.min(tops[section], available - height));
  // A cancelled fade (a theme change mid-way) closes the peek like a finished one.
  const closeOnFade = (event: TransitionEvent) => {
    if (!open && event.target === event.currentTarget && event.propertyName === "opacity")
      onClosed();
  };

  return (
    <div
      ref={cardRef}
      data-thread-details-peek={section}
      aria-hidden={!open}
      inert={!open}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEscape();
      }}
      onTransitionEnd={closeOnFade}
      onTransitionCancel={closeOnFade}
      className={cn(
        "dropdown-glass absolute top-0 right-full isolate me-2 w-76 overflow-hidden rounded-glass-list-item shadow-float",
        // Reduced motion keeps the fade, which onClosed waits on, and drops the slide.
        ready
          ? "transition-[translate,height,opacity] duration-200 ease-out motion-reduce:transition-opacity"
          : "opacity-0",
        !open && "pointer-events-none opacity-0",
      )}
      style={{ translate: `${ready && open ? 0 : 6}px ${top}px`, height }}
    >
      <div
        className={cn(
          ready && "transition-[translate] duration-200 ease-out motion-reduce:transition-none",
        )}
        style={{ translate: `0 ${-scrolled}px` }}
      >
        {THREAD_DETAILS_RAIL_SECTIONS.map((key) => (
          <div
            key={key}
            ref={(node) => {
              panelRefs.current[key] = node;
            }}
            aria-hidden={key !== section}
            inert={key !== section}
            // A section taller than the space beside the rail scrolls inside the card.
            className={cn("overflow-y-auto", key !== section && "pointer-events-none")}
            style={available > 0 ? { maxHeight: available } : undefined}
          >
            {key === "usage" ? (
              <ThreadUsagePanel
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
              />
            ) : (
              <ThreadRelationshipsPanel
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                showLineage={key === "agents"}
                showSideChats={key === "sideChats"}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
