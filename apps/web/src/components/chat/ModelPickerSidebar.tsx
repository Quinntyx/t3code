import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderLimitsSummary } from "@t3tools/shared/usageLimits";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { describeProviderLimits, ProviderLimitBars } from "./ModelPickerProviderLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label}: Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label}: ${kind}. ${msg}` : `${label}: ${kind}.`;
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;
const RECEDE_CLASS_NAME =
  "opacity-45 transition-opacity group-hover/provider:opacity-100 group-focus-within/provider:opacity-100";
const RECEDE_ICON_CLASS_NAME = `${RECEDE_CLASS_NAME} grayscale group-hover/provider:grayscale-0 group-focus-within/provider:grayscale-0`;

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  limitsByInstance?: ReadonlyMap<ProviderInstanceId, ProviderLimitsSummary>;
  now: number;
}) {
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
  ]);

  return (
    <Toolbar.Root
      className="w-11 shrink-0 overflow-hidden bg-muted/30 sm:w-60"
      data-model-picker-sidebar="true"
      aria-label="Providers"
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1 sm:p-2">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out sm:hidden"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-glass-item transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none max-sm:aspect-square sm:justify-start sm:rounded-glass-list-item sm:px-2.5 sm:py-2",
                          props.selectedInstanceId === "favorites" &&
                            "sm:bg-background/60 sm:shadow-xs/5 sm:ring-1 sm:ring-border/60",
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label="Favorites"
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                        <span className="text-sm font-medium max-sm:hidden">Favorites</span>
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className="sm:hidden"
                  >
                    Favorites
                  </TooltipPopup>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);
            const limits = props.limitsByInstance?.get(entry.instanceId);
            // Like an idle thread, a spent provider recedes until pointed at.
            const recedes = limits?.exhausted === true && !isDisabled;

            const tooltip = isUnavailable
              ? describeUnavailableInstance(entry)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : entry.displayName;
            const select = () => {
              if (!isDisabled) handleSelect(entry.instanceId);
            };

            const button = (
              <Toolbar.Button
                className={cn(
                  "relative isolate flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-glass-item outline-none max-sm:aspect-square max-sm:transition-colors max-sm:hover:bg-foreground/10 max-sm:focus-visible:bg-foreground/10 sm:justify-start sm:rounded-glass-list-item sm:px-2.5 sm:pt-2",
                  limits ? "sm:pb-0.5" : "sm:pb-2",
                  isDisabled && "cursor-not-allowed max-sm:hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={select}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                disabled={isDisabled}
                focusableWhenDisabled={!isDisabled}
                aria-pressed={isSelected}
                type="button"
                aria-label={[
                  isUnavailable || isContextDisabled ? tooltip : entry.displayName,
                  limits ? describeProviderLimits(limits) : null,
                ]
                  .filter(Boolean)
                  .join(": ")}
              >
                <span className={cn("flex", recedes && RECEDE_ICON_CLASS_NAME)}>
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    acpRegistryAgentId={entry.acpRegistryAgentId}
                    acpRegistryIconUrl={entry.acpRegistryIconUrl}
                    showBadge={showInstanceBadge}
                    className="size-6 z-30"
                    iconClassName="size-5"
                    indicatorBackground={
                      isHovered && !isDisabled
                        ? "var(--muted)"
                        : isSelected
                          ? "var(--background)"
                          : "color-mix(in oklab, var(--muted) 30%, transparent)"
                    }
                    {...(entry.accentColor
                      ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" }
                      : {})}
                  />
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-left text-sm font-medium max-sm:hidden",
                    recedes &&
                      "text-muted-foreground group-hover/provider:text-foreground group-focus-within/provider:text-foreground",
                  )}
                >
                  {entry.displayName}
                </span>
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className={cn(
                  "group/provider relative w-full sm:rounded-glass-list-item sm:transition-colors",
                  isSelected
                    ? "sm:bg-background/60 sm:shadow-xs/5 sm:ring-1 sm:ring-border/60"
                    : !isDisabled && "sm:hover:bg-foreground/5",
                  "sm:has-[button:focus-visible]:bg-foreground/10",
                  isDisabled && "opacity-50",
                )}
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={isUnavailable || isContextDisabled ? undefined : "sm:hidden"}
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
                {limits ? (
                  <div
                    className={cn(
                      "pointer-events-none px-2.5 pb-1.5 max-sm:hidden",
                      recedes && RECEDE_CLASS_NAME,
                    )}
                  >
                    <ProviderLimitBars
                      summary={limits}
                      driver={entry.driverKind}
                      providerName={entry.displayName}
                      now={props.now}
                      onSelect={select}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
