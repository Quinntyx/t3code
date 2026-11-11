import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "./pullRequestIcons";
import { resolvePullRequestState } from "./pullRequestPresentation";
import type { PullRequestStackRow } from "./pullRequestStack.logic";

/** A thread-derived stack as a small tree; rows with a pull request open it. */
export function PullRequestStackTree({
  rows,
  onSelect,
}: {
  rows: ReadonlyArray<PullRequestStackRow>;
  onSelect?: ((number: number) => void) | undefined;
}) {
  return (
    <ul className="flex flex-col text-xs">
      {rows.map((row) => {
        const pullRequest = row.pullRequest;
        const state = pullRequest ? resolvePullRequestState(pullRequest) : null;
        const content = (
          <>
            {Array.from({ length: row.depth }, (_, level) => (
              <span
                key={level}
                aria-hidden
                className="ml-1 w-2 shrink-0 self-stretch border-l border-border/70"
              />
            ))}
            {pullRequest && state ? (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-0.5 tabular-nums",
                  state.toneClassName,
                )}
              >
                <state.Icon aria-hidden className="size-3" />#{pullRequest.number}
              </span>
            ) : (
              <PullRequestGlyph.pullRequest
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground/30"
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                row.current ? "font-medium text-foreground" : "text-foreground/75",
              )}
            >
              {row.title}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {row.current ? "this" : (state?.label.toLowerCase() ?? "thread")}
            </span>
          </>
        );
        const rowClassName = "flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1";
        return (
          <li key={row.branch} aria-current={row.current || undefined}>
            {pullRequest && !row.current && onSelect ? (
              <button
                type="button"
                className={cn(rowClassName, "text-left hover:bg-accent")}
                onClick={() => onSelect(pullRequest.number)}
              >
                {content}
              </button>
            ) : (
              <div className={cn(rowClassName, row.current && "bg-accent")}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
