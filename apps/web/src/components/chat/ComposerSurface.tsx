import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

function Shell({
  contextRow = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextRow?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-liquid-glass=""
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-action-radius:1rem] [--chat-composer-action-inset:1rem] sm:[--chat-composer-action-inset:1.25rem]",
        "has-data-[chat-composer-action-size=large]:[--chat-composer-action-radius:1.125rem] sm:has-data-[chat-composer-action-size=large]:[--chat-composer-action-radius:1rem] sm:has-data-[chat-composer-action-size=small]:[--chat-composer-action-radius:0.875rem]",
        // The outer corner and inset action share a center, including the one-pixel surface border.
        "[--chat-composer-radius:calc(var(--chat-composer-action-radius)+var(--chat-composer-action-inset)+1px)] [--chat-composer-inner-radius:calc(var(--chat-composer-radius)-1px)]",
        "has-data-[chat-composer-resting=true]:[--chat-composer-action-inset:calc(1.75rem-var(--chat-composer-action-radius))] has-data-[chat-composer-mobile-collapsed=true]:[--chat-composer-action-inset:calc(1.75rem-var(--chat-composer-action-radius))]",
        "[--chat-composer-drawer-inset:1.75rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "[--chat-composer-glass-fill:color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--glass-opacity),transparent)]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-(--chat-composer-radius) before:bg-(--chat-composer-glass-fill) before:composer-frost",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
        contextRow && [
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
          "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:rounded-none",
          "before:[clip-path:shape(from_0_var(--chat-composer-radius),arc_to_var(--chat-composer-radius)_0_of_var(--chat-composer-radius)_cw,line_to_calc(100%-var(--chat-composer-radius))_0,arc_to_100%_var(--chat-composer-radius)_of_var(--chat-composer-radius)_cw,line_to_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-radius)),arc_to_calc(100%-var(--chat-composer-radius))_calc(100%-var(--chat-composer-context-extension))_of_var(--chat-composer-radius)_cw,line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),arc_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_of_16px_cw,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,arc_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_of_16px_cw,line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),line_to_var(--chat-composer-radius)_calc(100%-var(--chat-composer-context-extension)),arc_to_0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-radius))_of_var(--chat-composer-radius)_cw,line_to_0_var(--chat-composer-radius),close)]",
          "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-(--chat-composer-context-extension)",
        ],
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-(--chat-composer-radius) shadow-composer after:z-1 dark:shadow-none",
        outlineClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-(--chat-composer-radius) p-px",
        "group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-fill) group-data-model-strip-transition/composer-surface:composer-frost",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-fill) group-has-data-[composer-banner-surface=attached]/composer-surface:composer-frost",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/** A plain row under the card (environment, worktree, branch) with no surface of its own. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative flex w-full items-center gap-2 overflow-x-clip px-2 pt-2 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
