import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import { useState, type RefObject } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PullRequestStackMergeChoice } from "./pullRequestStack.logic";

function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button size="icon-micro" variant="ghost-muted" aria-label={label}>
            <InfoIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">{children}</TooltipPopup>
    </Tooltip>
  );
}

/** Confirms merging a pull request that has open pull requests stacked on it. */
export function PullRequestMergeDependentsConfirm({
  open,
  onOpenChange,
  anchor,
  copy,
  environmentId,
  projectId,
  ownerThreadRef,
  canRestack,
  onMerge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLElement | null>;
  copy: NonNullable<PullRequestStackMergeChoice["dependents"]>;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  ownerThreadRef: ScopedThreadRef | null;
  canRestack: boolean;
  onMerge: (restackDependents: boolean) => Promise<boolean>;
}) {
  const { settleThread } = useThreadActions();
  const autoSettleOnMerge = useEnvironmentSettings(
    environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.sidebarAutoSettleOnMerge,
  );
  const owner = useThreadShell(ownerThreadRef);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const offersSettle =
    ownerThreadRef !== null &&
    owner !== null &&
    canOperate &&
    !(autoSettleOnMerge && owner.autoSettleDisabledAt == null);
  const merge = async (choice: { restack: boolean; settle: boolean }) => {
    onOpenChange(false);
    const merged = await onMerge(choice.restack && canRestack);
    if (merged && choice.settle && offersSettle && ownerThreadRef !== null) {
      void settleThread(ownerThreadRef);
    }
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup anchor={anchor} align="end" side="bottom" width="sm" padding="compact">
        <MergeDependentsForm
          copy={copy}
          canRestack={canRestack}
          offersSettle={offersSettle}
          onCancel={() => onOpenChange(false)}
          onMerge={(choice) => void merge(choice)}
        />
      </PopoverPopup>
    </Popover>
  );
}

function MergeDependentsForm({
  copy,
  canRestack,
  offersSettle,
  onCancel,
  onMerge,
}: {
  copy: NonNullable<PullRequestStackMergeChoice["dependents"]>;
  canRestack: boolean;
  offersSettle: boolean;
  onCancel: () => void;
  onMerge: (choice: { restack: boolean; settle: boolean }) => void;
}) {
  const [restack, setRestack] = useState(canRestack);
  const [settle, setSettle] = useState(false);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <PopoverTitle>{copy.title}</PopoverTitle>
      <div className="flex items-center gap-1 text-muted-foreground">
        <span className="min-w-0">{copy.moves}</span>
        <InfoTip label="Where they move">{copy.movesInfo}</InfoTip>
      </div>
      <div className="flex items-center gap-1">
        <label className="flex min-w-0 items-center gap-2">
          <Checkbox
            checked={restack}
            disabled={!canRestack}
            onCheckedChange={(checked) => setRestack(checked === true)}
          />
          {copy.restack}
        </label>
        <InfoTip label="What restacking does">{copy.restackInfo}</InfoTip>
      </div>
      {offersSettle ? (
        <label className="flex min-w-0 items-center gap-2">
          <Checkbox checked={settle} onCheckedChange={(checked) => setSettle(checked === true)} />
          Settle this thread
        </label>
      ) : null}
      <div className="mt-1 flex justify-end gap-2">
        <Button size="xs" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => onMerge({ restack, settle })}>
          Merge
        </Button>
      </div>
    </div>
  );
}
