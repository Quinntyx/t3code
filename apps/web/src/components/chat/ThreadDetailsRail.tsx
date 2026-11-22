import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ServerProvider, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { formatThreadUsageCost, formatTokens } from "@t3tools/shared/usageFormat";
import { useGT } from "gt-react";
import { MessagesSquareIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useThreadUsage } from "../../hooks/useThreadUsage";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { resolveThreadOpenRoute } from "../../lib/sideChatPane";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import {
  useHiddenThreadKeys,
  useThreadProjection,
  useThreadRelationshipShells,
} from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsRailPeek } from "./ThreadDetailsRailPeek";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { buildRailRows, buildRailSideChats, type RailRow } from "./threadDetailsRail.logic";
import {
  selectThreadDetailsRailSection,
  useThreadDetailsRailStore,
  type ThreadDetailsRailSection,
} from "./threadDetailsRailStore";

/** Totals, one icon per active agent (newest first) and one per side chat; each part opens its card. */
export function ThreadDetailsRail({
  threadRef,
  onOpenThread,
  peekEnabled,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Off while the full card is pinned open, which already shows every section. */
  readonly peekEnabled: boolean;
}) {
  const { environmentId, threadId } = threadRef;
  const gt = useGT();
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const relationshipShells = useThreadRelationshipShells(threadRef);
  const hiddenKeys = useHiddenThreadKeys();
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const { data: usage } = useThreadUsage(threadRef);
  const hoveredSection = useThreadDetailsRailStore((state) =>
    selectThreadDetailsRailSection(state.hoveredSectionByThreadKey, threadRef),
  );
  const hover = (section: ThreadDetailsRailSection | null) =>
    useThreadDetailsRailStore.getState().setHovered(threadRef, section);
  // Focus handed back after Escape lands on its opener without reopening the card.
  const returningFocusRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusOpen = (section: ThreadDetailsRailSection, opener: EventTarget) => {
    if (returningFocusRef.current) {
      returningFocusRef.current = false;
      return;
    }
    if (opener instanceof HTMLElement) openerRef.current = opener;
    hover(section);
  };
  // Keyboard focus keeps a card open while the pointer wanders off, and it closes only once focus
  // leaves both the rail and the card.
  const pointerLeave = () => {
    if (!capRef.current?.contains(document.activeElement)) hover(null);
  };
  const focusLeave = (next: EventTarget | null) => {
    if (!(next instanceof Node && capRef.current?.contains(next))) hover(null);
  };
  // Keeps the last card mounted while it fades out, then unmounts on transitionend.
  const peekOpen = peekEnabled && hoveredSection !== null;
  const [shownSection, setShownSection] = useState(hoveredSection);
  if (peekOpen && hoveredSection !== shownSection) setShownSection(hoveredSection);
  if (!peekEnabled && shownSection !== null) setShownSection(null);
  const peekSection = peekOpen ? hoveredSection : shownSection;

  const providers = providersByEnvironment.get(environmentId);
  const providerEntries = settings
    ? applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers ?? []),
        settings,
        projection?.thread.projectId ?? null,
      )
    : deriveProviderInstanceEntries(providers ?? []);

  const rows = buildRailRows(projection);
  const sideChats = buildRailSideChats({
    threadId,
    projection,
    shells: relationshipShells,
    isHidden: (relatedThreadId) =>
      hiddenKeys.has(threadKey({ environmentId, threadId: relatedThreadId })),
  });

  const runningCount = rows.filter((row) => row.status === "running").length;
  const totalTokens = usage?.models.reduce((sum, model) => sum + model.totalTokens, 0) ?? 0;
  const cost =
    usage == null || usage.models.length === 0
      ? null
      : formatThreadUsageCost(usage.models, usage.incompleteGroups !== undefined);

  const capRef = useRef<HTMLDivElement | null>(null);
  // The rail lays every row out and hides the ones past the cap, so the fit is measured from the
  // rows themselves rather than from sizes the stylesheet could round differently.
  const [capped, setCapped] = useState({ count: rows.length, more: 0 });
  const hasContent = rows.length > 0 || sideChats.length > 0 || cost !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the dock's rendered rows and hides the ones past the available height
  useLayoutEffect(() => {
    const dock = capRef.current;
    if (!hasContent || !dock) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rail = dock.querySelector<HTMLElement>("[data-thread-details-rail]");
        const list = rail?.querySelector<HTMLElement>("[data-thread-rail-rows]");
        const pill = rail?.querySelector<HTMLElement>("[data-thread-rail-more]");
        if (!rail || !list || !pill) return;
        const rowNodes = Array.from(list.children) as HTMLElement[];
        for (const node of rowNodes) node.style.display = "";
        const setShown = (count: number) => {
          for (const [index, node] of rowNodes.entries())
            node.style.display = index >= count ? "none" : "";
        };
        // Fit against the rail's own overflow, read once with every row and the pill's line
        // showing; then drop rows from the end by their measured spans, gaps and dividers included.
        pill.hidden = false;
        const bottoms = rowNodes.map((node) => node.getBoundingClientRect().bottom);
        const firstTop = rowNodes[0]?.getBoundingClientRect().top ?? 0;
        const overflowWithPill = rail.scrollHeight - rail.clientHeight;
        pill.hidden = true;
        let shown = rowNodes.length;
        if (rail.scrollHeight - rail.clientHeight > 0) {
          let excess = overflowWithPill;
          while (shown > 0 && excess > 0) {
            shown -= 1;
            excess -= (bottoms[shown] ?? 0) - (bottoms[shown - 1] ?? firstTop);
          }
          pill.hidden = false;
          setShown(shown);
          // Subpixel rounding can leave a sliver; one more read settles it.
          if (shown > 0 && rail.scrollHeight - rail.clientHeight > 0) {
            shown -= 1;
            setShown(shown);
          }
        }
        const more = rowNodes.length - shown;
        setShown(shown);
        setCapped((current) =>
          current.count === shown && current.more === more ? current : { count: shown, more },
        );
      });
    };
    measure();
    // The row list resizes when agents come and go; the dock when the window does.
    const list = dock.querySelector("[data-thread-rail-rows]");
    const stop = observeResize(list ? [dock, list] : dock, measure);
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [hasContent]);

  const providerOf = (instanceId: string) =>
    providers?.find((provider) => provider.instanceId === instanceId);

  if (!hasContent) return null;
  return (
    <div
      ref={capRef}
      className="absolute top-3 right-3 bottom-14 z-20 flex w-9 flex-col items-end"
      data-thread-details-rail-cap
    >
      <div
        role="group"
        aria-label={gt(
          "Thread details: {tokens} tokens, {running} agents running, {sideChats} side chats",
          { tokens: formatTokens(totalTokens), running: runningCount, sideChats: sideChats.length },
        )}
        data-thread-details-rail
        // Sections open their own card; the empty dock below the rail opens nothing.
        onPointerLeave={pointerLeave}
        // Keyboard focus opens a section's card as the pointer does; Escape closes it.
        onBlur={(event) => focusLeave(event.relatedTarget)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            hover(null);
            return;
          }
          // The card follows every rail control in tab order, so Enter on a focusable section or
          // ArrowLeft from anywhere in the rail steps into the open card instead.
          const onSection =
            event.target instanceof HTMLElement && event.target.dataset.railSection !== undefined;
          if (
            event.key !== "ArrowLeft" &&
            !(onSection && (event.key === "Enter" || event.key === " "))
          )
            return;
          const first = capRef.current?.querySelector<HTMLElement>(
            "[data-thread-details-peek] :is(button, a[href], [tabindex]):not([disabled], [tabindex='-1'], [inert] *)",
          );
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        className="relative isolate flex max-h-full min-h-0 w-9 flex-col items-center gap-px overflow-hidden rounded-md py-1 shadow-float"
      >
        <div aria-hidden className="panel-glass" />
        {cost === null ? null : (
          <span
            data-rail-section="usage"
            tabIndex={0}
            role="button"
            aria-expanded={hoveredSection === "usage"}
            aria-label={gt("Usage: {tokens} tokens, {cost}", {
              tokens: formatTokens(totalTokens),
              cost,
            })}
            onPointerEnter={() => hover("usage")}
            onFocus={(event) => focusOpen("usage", event.target)}
            className="flex w-full shrink-0 flex-col items-center rounded-md pt-0.5 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="text-3xs leading-3 font-medium tabular-nums text-foreground/85">
              {formatTokens(totalTokens)}
            </span>
            <span className="text-3xs leading-3 tabular-nums text-muted-foreground">{cost}</span>
          </span>
        )}
        {rows.length === 0 ? null : <RailSeparator />}
        <div
          data-rail-section="agents"
          // Remote agents' buttons are disabled, so a section of only those takes focus itself.
          {...(rows.length > 0 && rows.every((row) => row.kind === "remote")
            ? {
                tabIndex: 0,
                role: "button",
                "aria-label": gt("Agents: {count} on other machines", { count: rows.length }),
                "aria-expanded": hoveredSection === "agents",
              }
            : {})}
          onPointerEnter={() => hover("agents")}
          onFocus={(event) => focusOpen("agents", event.target)}
          className="flex w-full flex-col items-center gap-px rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <div data-thread-rail-rows className="flex w-full flex-col items-center gap-px">
            {rows.map((row, index) => (
              <div key={row.id} className="flex w-full flex-col items-center gap-px">
                {row.divider === null || row.divider === rows[index - 1]?.divider ? null : (
                  <RailDivider label={row.divider} first={index === 0} />
                )}
                <RailAgentButton
                  row={row}
                  provider={providerOf(row.providerInstanceId)}
                  providerEntries={providerEntries}
                  onOpenThread={onOpenThread}
                />
              </div>
            ))}
          </div>
          <span
            hidden={capped.more === 0}
            data-thread-rail-more
            className="mt-0.5 flex h-5 shrink-0 items-center justify-center rounded-md bg-black/[0.055] px-1 text-3xs leading-3 tabular-nums text-muted-foreground dark:bg-white/[0.075]"
          >
            +{capped.more}
          </span>
        </div>
        {sideChats.length === 0 ? null : (
          <>
            <RailSeparator />
            <div
              data-rail-section="sideChats"
              onPointerEnter={() => hover("sideChats")}
              onFocus={(event) => focusOpen("sideChats", event.target)}
              className="flex w-full flex-col items-center gap-px"
            >
              {sideChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  aria-label={gt("{title} · Side chat · {status}", {
                    title: chat.title,
                    status: threadRelationshipStatusLabel(chat.status),
                  })}
                  onClick={() =>
                    resolveThreadOpenRoute(scopeThreadRef(environmentId, chat.threadId), chat.shell)
                  }
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]"
                >
                  <ThreadRelationshipIcon
                    fallbackIcon={MessagesSquareIcon}
                    status={chat.status === "running" ? "running" : null}
                  />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {peekSection === null ? null : (
        <ThreadDetailsRailPeek
          threadRef={threadRef}
          section={peekSection}
          open={peekOpen}
          onClosed={() => setShownSection(null)}
          onPointerEnter={() => hover(peekSection)}
          onPointerLeave={pointerLeave}
          onFocus={() => hover(peekSection)}
          onBlur={(event) => focusLeave(event.relatedTarget)}
          onEscape={() => {
            hover(null);
            // The closing card turns inert, so focus goes back to the control that opened it.
            const opener = openerRef.current;
            if (!opener?.isConnected) return;
            returningFocusRef.current = true;
            opener.focus();
          }}
        />
      )}
    </div>
  );
}

function RailSeparator() {
  return <span aria-hidden className="my-1 h-px w-4 shrink-0 bg-border" />;
}

/** A 1px line with a taller hover target, naming the workflow stage it opens. */
function RailDivider({ label, first }: { readonly label: string; readonly first: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={100}
        render={
          <span
            data-rail-divider
            role="separator"
            aria-label={label}
            className={cn(
              "group/rail-divider flex h-2 w-9 shrink-0 cursor-default items-center justify-center",
              !first && "-mt-px",
            )}
          />
        }
      >
        <span className="h-px w-4 bg-border group-hover/rail-divider:bg-muted-foreground/60" />
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RailAgentButton({
  row,
  provider,
  providerEntries,
  onOpenThread,
}: {
  readonly row: RailRow;
  readonly provider: ServerProvider | undefined;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const statusLabel = threadRelationshipStatusLabel(row.status);
  const label =
    row.kind === "remote"
      ? gt("{title} · on {machine} · {status}", {
          title: row.title,
          machine: row.environmentLabel,
          status: statusLabel,
        })
      : row.workflowName === null
        ? gt("{title} · {status}", { title: row.title, status: statusLabel })
        : gt("{title} · {workflow} · {status}", {
            title: row.title,
            workflow: row.workflowName,
            status: statusLabel,
          });
  return (
    <button
      type="button"
      aria-label={label}
      disabled={row.kind === "remote"}
      onClick={() => {
        if (row.kind === "agent" && row.childThreadId !== null) onOpenThread(row.childThreadId);
      }}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-black/[0.055] hover:text-foreground/80 disabled:cursor-default dark:hover:bg-white/[0.075]",
        // Idle agents step back so the ones still working stand out.
        row.status === "idle" && "opacity-55 hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      <ThreadRelationshipIcon
        driver={row.driver}
        provider={provider}
        providerEntries={providerEntries}
        status={row.status}
      />
    </button>
  );
}
