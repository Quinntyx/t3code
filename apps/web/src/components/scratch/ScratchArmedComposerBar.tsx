import { ImageIcon, XIcon } from "lucide-react";
import { useGT } from "gt-react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Replaces the composer text input while a scratch chunk is armed; the composer's own
 * model/effort/send footer and BranchToolbar stay directly below in their normal positions.
 */
export function ScratchArmedComposerBar({
  title,
  imageCount,
  releaseShortcutLabel,
  onScrollToArmed,
  onRelease,
}: {
  readonly title: string;
  readonly imageCount: number;
  readonly releaseShortcutLabel?: string | null | undefined;
  readonly onScrollToArmed?: (() => void) | undefined;
  readonly onRelease: () => void;
}) {
  const gt = useGT();

  return (
    <div data-scratch-armed-bar className="flex min-h-9 items-center gap-2 py-0.5">
      <span aria-hidden className="h-5 w-0.5 shrink-0 rounded-full bg-primary" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onScrollToArmed}
              onPointerDown={(event) => event.preventDefault()}
              className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
            />
          }
        >
          <span className="truncate text-sm text-foreground">{title}</span>
          {imageCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-2xs tabular-nums text-accent-foreground">
              <ImageIcon className="size-3" />
              {imageCount}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{gt("Scroll to selection")}</TooltipPopup>
      </Tooltip>
      <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<Kbd variant="outline" />}>↵</TooltipTrigger>
          <TooltipPopup side="top">{gt("Send with Enter")}</TooltipPopup>
        </Tooltip>
        {releaseShortcutLabel ? (
          <Tooltip>
            <TooltipTrigger render={<Kbd variant="outline" />}>
              {releaseShortcutLabel}
            </TooltipTrigger>
            <TooltipPopup side="top">{gt("Release selection")}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-muted"
                onPointerDown={(event) => event.preventDefault()}
                onClick={onRelease}
                aria-label={gt("Release selection")}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">{gt("Release selection")}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
