import { useLegendListRef } from "~/hooks/useLegendListRef";
import type { EnvironmentId, ProjectId, VcsRef } from "@t3tools/contracts";
import {
  branchNameWithinRemote,
  branchPickerRefTarget,
  branchPickerRemotes,
  parentBranchPickerRemoteView,
  type BranchPickerRemotes,
  type BranchPickerRemoteView,
} from "@t3tools/client-runtime/state/vcs";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { MiddleTruncate } from "./ui/middle-truncate";
import { cn } from "../lib/utils";
import { RefreshIcon } from "./ui/refresh-icon";
import { Switch } from "./ui/switch";
import { getVirtualizedScrollFadeClassName } from "./ui/scroll-area";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
} from "./ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Git ref names cannot contain ":", so these never collide with a ref.
const REMOTE_ITEM_PREFIX = "remote:";

/** Tier state for a picker that lists the project's default remote first. */
export function useBranchPickerRemoteView(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  const preferredRemoteName = useEnvironmentSettings(
    environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.defaultBranchRemote,
  );
  const [view, setView] = useState<BranchPickerRemoteView>({ kind: "default" });
  return {
    view,
    refTarget: branchPickerRefTarget(view, preferredRemoteName),
    remotes: (remoteNames: ReadonlyArray<string> | undefined): BranchPickerRemotes =>
      branchPickerRemotes({ view, onViewChange: setView, remoteNames, preferredRemoteName }),
  };
}

export function BranchPicker({
  items,
  filteredItems,
  value,
  query,
  onQueryChange,
  open,
  onOpenChange,
  onSelectItem,
  hasNextPage,
  isFetchingNextPage,
  onLoadNext,
  statusText,
  originControl,
  remotes,
  popupProps,
  renderItem,
  getItemType,
  children,
}: {
  items: string[];
  filteredItems: string[];
  value: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectItem: (value: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadNext: () => void;
  statusText: string | null;
  originControl?: { checked: boolean; onCheckedChange: (checked: boolean) => void } | undefined;
  remotes?: BranchPickerRemotes | undefined;
  popupProps: Omit<ComponentProps<typeof ComboboxPopup>, "children">;
  renderItem: (value: string, index: number) => ReactNode;
  getItemType?: ((value: string) => string) | undefined;
  children: ReactNode;
}) {
  const highlightedValueRef = useRef<string | null>(null);
  const startFromOriginSwitchId = useId();
  const otherRemotesButtonRef = useRef<HTMLButtonElement | null>(null);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      highlightedValueRef.current = null;
      if (remotes && remotes.view.kind !== "default") remotes.onViewChange({ kind: "default" });
    }
    onOpenChange(nextOpen);
  };
  const remoteView = remotes?.view ?? { kind: "default" as const };
  const changeRemoteView = (view: BranchPickerRemoteView) => {
    highlightedValueRef.current = null;
    onQueryChange("");
    remotes?.onViewChange(view);
    void branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  };
  const normalizedQuery = query.trim().toLowerCase();
  const remoteListItems =
    remotes && remoteView.kind === "remotes"
      ? remotes.otherRemoteNames
          .filter((name) => name.toLowerCase().includes(normalizedQuery))
          .map((name) => `${REMOTE_ITEM_PREFIX}${name}`)
      : null;
  const listItems = remoteListItems ?? filteredItems;
  const selectItem = (itemValue: string) => {
    if (remoteListItems && itemValue.startsWith(REMOTE_ITEM_PREFIX)) {
      changeRemoteView({
        kind: "remote",
        remoteName: itemValue.slice(REMOTE_ITEM_PREFIX.length),
      });
      return;
    }
    // Keyboard selection closes through the parent's open prop, which skips handleOpenChange.
    if (remotes && remoteView.kind !== "default") remotes.onViewChange({ kind: "default" });
    onSelectItem(itemValue);
  };
  const renderListItem = (itemValue: string, index: number) =>
    remoteListItems ? (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        onClick={(event) => {
          // Opening a remote keeps the popup open; Base UI closes it on item clicks.
          (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
          selectItem(itemValue);
        }}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <MiddleTruncate value={itemValue.slice(REMOTE_ITEM_PREFIX.length)} className="flex-1" />
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        </div>
      </ComboboxItem>
    ) : (
      renderItem(itemValue, index)
    );
  const [showTopBranchScrollFade, setShowTopBranchScrollFade] = useState(false);
  const [showBottomBranchScrollFade, setShowBottomBranchScrollFade] = useState(false);
  const fetchNextBranchPage = () => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }

    onLoadNext();
  };
  const branchListRef = useRef<LegendListRef | null>(null);
  const updateBranchListScrollFades = () => {
    const metrics = branchListRef.current?.getState();
    if (!metrics) return;
    setShowTopBranchScrollFade(!metrics.isAtStart);
    setShowBottomBranchScrollFade(!metrics.isAtEnd);
  };
  const branchScrollRef = useLegendListRef(branchListRef, updateBranchListScrollFades);

  return (
    <Combobox
      items={remoteListItems ?? items}
      filteredItems={listItems}
      autoHighlight
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        highlightedValueRef.current = typeof value === "string" ? value : null;
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
          return;
        }
        void branchListRef.current?.scrollIndexIntoView?.({
          index: eventDetails.index,
          animated: false,
        });
      }}
      onOpenChange={handleOpenChange}
      open={open}
      value={value}
    >
      {children}
      <ComboboxPopup {...popupProps}>
        <ComboboxSearchInput
          placeholder="Search refs..."
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            void branchListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
          }}
          onKeyDown={(event) => {
            if (
              remotes &&
              remoteView.kind !== "default" &&
              event.key === "Backspace" &&
              query.length === 0
            ) {
              event.preventDefault();
              changeRemoteView(parentBranchPickerRemoteView(remoteView, remotes.otherRemoteNames));
              return;
            }
            // The combobox keeps Tab in its input, so the remotes row needs an explicit way in.
            if (event.key === "Tab" && !event.shiftKey && otherRemotesButtonRef.current) {
              (
                event as typeof event & { preventBaseUIHandler?: () => void }
              ).preventBaseUIHandler?.();
              event.preventDefault();
              otherRemotesButtonRef.current.focus();
              return;
            }
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            // A tier change clears the tracked highlight while autoHighlight still marks the first row.
            const trackedValue = highlightedValueRef.current;
            const highlightedValue =
              trackedValue !== null && listItems.includes(trackedValue)
                ? trackedValue
                : remotes && remoteView.kind !== "default"
                  ? (listItems[0] ?? null)
                  : null;
            if (highlightedValue === null) return;
            (
              event as typeof event & { preventBaseUIHandler?: () => void }
            ).preventBaseUIHandler?.();
            event.preventDefault();
            event.stopPropagation();
            highlightedValueRef.current = null;
            selectItem(highlightedValue);
          }}
        />
        {remotes && remoteView.kind !== "default" ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() =>
              changeRemoteView(parentBranchPickerRemoteView(remoteView, remotes.otherRemoteNames))
            }
          >
            <ChevronLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              {remoteView.kind === "remote" ? remoteView.remoteName : "Other remotes"}
            </span>
          </button>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>{remoteListItems ? "No remotes found." : "No refs found."}</ComboboxEmpty>
          <div className="relative flex min-h-0 w-full max-h-56 flex-1 flex-col overflow-hidden">
            <ComboboxListVirtualized className="flex size-full min-h-0 min-w-0 flex-col">
              <LegendList<string>
                ref={branchScrollRef}
                data={listItems}
                initialScrollOffset={0}
                keyExtractor={(item) => item}
                {...(getItemType && !remoteListItems ? { getItemType } : {})}
                renderItem={({ item, index }) => renderListItem(item, index)}
                estimatedItemSize={28}
                drawDistance={336}
                onScroll={updateBranchListScrollFades}
                onLayout={updateBranchListScrollFades}
                onReady={updateBranchListScrollFades}
                onEndReached={fetchNextBranchPage}
                onEndReachedThreshold={0.5}
                className={cn(
                  "min-h-0 max-h-56 scrollbar-gutter-stable overflow-x-hidden overscroll-y-contain ps-1 pe-0 py-2",
                  getVirtualizedScrollFadeClassName({
                    top: showTopBranchScrollFade,
                    bottom: showBottomBranchScrollFade,
                  }),
                )}
              />
            </ComboboxListVirtualized>
          </div>
          {remotes && remoteView.kind === "default" && remotes.otherRemoteNames.length > 0 ? (
            <button
              ref={otherRemotesButtonRef}
              type="button"
              className="flex min-w-0 items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-left text-xs hover:bg-accent/50"
              onClick={() => {
                highlightedValueRef.current = null;
                onQueryChange("");
                remotes.onOpenOtherRemotes();
              }}
            >
              <span className="shrink-0 font-medium text-muted-foreground">Other remotes</span>
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground/70">
                <span className="truncate">{remotes.otherRemoteNames.join(", ")}</span>
                <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
              </span>
            </button>
          ) : null}
          {originControl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <label
                    htmlFor={startFromOriginSwitchId}
                    className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
                      <RefreshIcon aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate">Start from remote</span>
                    </span>
                    <Switch
                      id={startFromOriginSwitchId}
                      checked={originControl.checked}
                      size="sm"
                      aria-label="Start worktree from remote"
                      onCheckedChange={(checked) => originControl.onCheckedChange(Boolean(checked))}
                    />
                  </label>
                }
              />
              <TooltipPopup side="top" className="max-w-72 whitespace-normal">
                Uses the latest commit of the base branch’s tracked remote branch, even if its name
                differs. Otherwise uses the same-named branch on origin. Uses your local branch if
                that remote branch is missing.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

export function BranchPickerRefItem({
  branch: refName,
  projectCwd: activeProjectCwd,
  index,
  value,
  disabled,
  withinRemote = false,
  onClick,
  onContextMenu,
}: {
  branch: VcsRef;
  projectCwd: string | null;
  index: number;
  value?: string;
  disabled?: boolean;
  /** Lists already grouped under the ref's remote drop its remote prefix and badge. */
  withinRemote?: boolean;
  onClick: ComponentProps<typeof ComboboxItem>["onClick"];
  onContextMenu?: ComponentProps<typeof ComboboxItem>["onContextMenu"];
}) {
  const itemValue = refName.name;
  const hasSecondaryWorktree =
    refName.worktreePath && activeProjectCwd && refName.worktreePath !== activeProjectCwd;
  const badge = refName.current
    ? "current"
    : hasSecondaryWorktree
      ? "worktree"
      : refName.isRemote && !withinRemote
        ? "remote"
        : refName.isDefault
          ? "default"
          : null;
  return (
    <ComboboxItem
      disabled={disabled}
      hideIndicator
      key={itemValue}
      index={index}
      value={value ?? itemValue}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <MiddleTruncate
          value={withinRemote ? branchNameWithinRemote(refName) : itemValue}
          className="flex-1"
        />
        {badge && <span className="shrink-0 text-3xs text-muted-foreground/45">{badge}</span>}
      </div>
    </ComboboxItem>
  );
}
