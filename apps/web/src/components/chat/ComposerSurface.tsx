import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { setLiquidGlassShape } from "~/liquid-glass/engine";
import { composerGlassShape } from "./composerGlass";

function Shell({
  contextRow = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "ref"> & { contextRow?: boolean }) {
  return (
    <div
      ref={(element) => {
        if (!element) return;
        setLiquidGlassShape(element, () => composerGlassShape(element));
        return () => setLiquidGlassShape(element, null);
      }}
      data-slot="composer-shell"
      data-liquid-glass=""
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "[html[data-theme-id]_&]:[--chat-composer-glass-surface:var(--app-theme-surface-raised)] [html[data-theme-id]_&]:[--chat-composer-outline:var(--app-theme-toolbar-border)]",
        "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-highlight:color-mix(in_srgb,var(--app-theme-input)_12%,transparent)] dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-outline:color-mix(in_srgb,var(--app-theme-input)_30%,var(--background))]",
        "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-highlight:color-mix(in_srgb,#432d48_12%,transparent)] dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-outline:#241e28]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-2xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden",
        // With a context row below, stock Host paints its own glass; Liquid Glass re-enables Shell's frost above the extension.
        "data-context-row:before:hidden",
        // Liquid Glass style overrides (inactive when style is None).
        "[html[data-liquid-glass]_&]:[--chat-composer-action-radius:1rem] [html[data-liquid-glass]_&]:[--chat-composer-action-inset:1rem] sm:[html[data-liquid-glass]_&]:[--chat-composer-action-inset:1.25rem]",
        "[html[data-liquid-glass]_&]:has-data-[chat-composer-action-size=large]:[--chat-composer-action-radius:1.125rem] sm:[html[data-liquid-glass]_&]:has-data-[chat-composer-action-size=large]:[--chat-composer-action-radius:1rem] sm:[html[data-liquid-glass]_&]:has-data-[chat-composer-action-size=small]:[--chat-composer-action-radius:0.875rem]",
        "[html[data-liquid-glass]_&]:[--chat-composer-radius:calc(var(--chat-composer-action-radius)+var(--chat-composer-action-inset)+1px)] [html[data-liquid-glass]_&]:[--chat-composer-inner-radius:calc(var(--chat-composer-radius)-1px)] [html[data-liquid-glass]_&]:[--chat-composer-tile-radius:var(--chat-composer-action-radius)]",
        "[html[data-liquid-glass]_&]:has-data-[chat-composer-resting=true]:[--chat-composer-action-inset:calc(1.75rem-var(--chat-composer-action-radius))] [html[data-liquid-glass]_&]:has-data-[chat-composer-mobile-collapsed=true]:[--chat-composer-action-inset:calc(1.75rem-var(--chat-composer-action-radius))]",
        "[html[data-liquid-glass]_&]:[--chat-composer-drawer-inset:1.75rem]",
        "[html[data-liquid-glass]_&]:[--chat-composer-glass-fill:color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--glass-opacity),transparent)] [html[data-liquid-glass]_&]:[--glass-liquid-edge:var(--chat-composer-outline)]",
        "[html[data-liquid-glass]_&]:before:rounded-(--chat-composer-radius) [html[data-liquid-glass]_&]:before:bg-(--chat-composer-glass-fill) [html[data-liquid-glass]_&]:before:composer-frost [html[data-liquid-glass]_&]:before:glass-glare",
        "[html[data-liquid-glass]_&]:data-model-strip-transition:before:hidden",
        contextRow && [
          "[html[data-liquid-glass]_&]:[--chat-composer-context-extension:2.25rem] sm:[html[data-liquid-glass]_&]:[--chat-composer-context-extension:2rem]",
          "[html[data-liquid-glass]_&]:[--chat-composer-strip-inset:0.25rem] [html[data-liquid-glass]_&]:[--chat-composer-strip-radius:calc(var(--control-radius)+var(--chat-composer-strip-inset))]",
          "[html[data-liquid-glass]_&]:[--chat-composer-drawer-padding:calc(var(--chat-composer-drawer-inset)+var(--chat-composer-strip-inset))]",
          "[html[data-liquid-glass]_&]:data-context-row:before:block [html[data-liquid-glass]_&]:before:bottom-(--chat-composer-context-extension)",
        ],
        className,
      )}
      {...props}
    >
      <div data-slot="composer-glass-shadow" aria-hidden="true" />
      {children}
    </div>
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

const contextSeamClasses =
  "[html[data-liquid-glass]_&]:group-data-[context-row=true]/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-var(--chat-composer-drawer-inset))_100%,calc(100%-var(--chat-composer-drawer-inset))_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%-2px),var(--chat-composer-drawer-inset)_100%,0_100%)]";

const contextShadowClasses =
  "[html[data-liquid-glass]_&]:group-data-[context-row=true]/composer-surface:before:[clip-path:polygon(-100px_-100px,calc(100%_+_100px)_-100px,calc(100%_+_100px)_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%_+_100px),-100px_calc(100%_+_100px))]";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-2xl shadow-composer after:z-1 dark:shadow-none",
        "group-data-context-row/composer-surface:before:pointer-events-none group-data-context-row/composer-surface:before:absolute group-data-context-row/composer-surface:before:inset-0 group-data-context-row/composer-surface:before:-z-1 group-data-context-row/composer-surface:before:rounded-2xl group-data-context-row/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-context-row/composer-surface:before:backdrop-blur-(--glass-blur) group-data-context-row/composer-surface:before:backdrop-saturate-(--glass-saturation)",
        "[html[data-liquid-glass]_&]:rounded-(--chat-composer-radius) [html[data-liquid-glass]_&]:shadow-none",
        "[html[data-liquid-glass]_&]:before:pointer-events-none [html[data-liquid-glass]_&]:before:absolute [html[data-liquid-glass]_&]:before:inset-0 [html[data-liquid-glass]_&]:before:-z-1 [html[data-liquid-glass]_&]:before:rounded-[inherit] [html[data-liquid-glass]_&]:before:bg-transparent [html[data-liquid-glass]_&]:before:backdrop-blur-none [html[data-liquid-glass]_&]:before:backdrop-saturate-100 [html[data-liquid-glass]_&]:before:shadow-float",
        outlineClasses,
        contextSeamClasses,
        contextShadowClasses,
        "[html[data-liquid-glass]_&]:group-data-liquid-glass-shaped/composer-surface:before:hidden",
        "[html[data-liquid-glass]_&]:group-data-liquid-glass-shaped/composer-surface:after:hidden",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:before:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
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
        "group relative z-10 rounded-2xl p-px",
        "[html[data-liquid-glass]_&]:rounded-(--chat-composer-radius)",
        "[html[data-liquid-glass]_&]:group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-fill) [html[data-liquid-glass]_&]:group-data-model-strip-transition/composer-surface:composer-frost",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "[html[data-liquid-glass]_&]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-fill) [html[data-liquid-glass]_&]:group-has-data-[composer-banner-surface=attached]/composer-surface:composer-frost [html[data-liquid-glass]_&]:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-float",
        "[html[data-liquid-glass]_&]:group-data-[context-row=true]/composer-surface:group-has-data-[composer-banner-surface=attached]/composer-surface:[clip-path:polygon(-100px_-100px,calc(100%_+_100px)_-100px,calc(100%_+_100px)_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%_+_100px),-100px_calc(100%_+_100px))]",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/** A row under the card (environment, worktree, branch); page-coloured glass by default, attached pill under Liquid Glass. */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context surface-glass relative flex w-full items-center gap-2 overflow-x-clip px-2 pt-2 text-muted-foreground",
        "[html[data-liquid-glass]_&]:isolate [html[data-liquid-glass]_&]:z-20 [html[data-liquid-glass]_&]:h-(--chat-composer-context-extension) [html[data-liquid-glass]_&]:bg-transparent [html[data-liquid-glass]_&]:px-(--chat-composer-drawer-padding,2rem) [html[data-liquid-glass]_&]:pt-0 [html[data-liquid-glass]_&]:backdrop-blur-none [html[data-liquid-glass]_&]:backdrop-saturate-100",
        "[html[data-liquid-glass]_&]:before:pointer-events-none [html[data-liquid-glass]_&]:before:absolute [html[data-liquid-glass]_&]:before:inset-x-(--chat-composer-drawer-inset,1.75rem) [html[data-liquid-glass]_&]:before:inset-y-0 [html[data-liquid-glass]_&]:before:-z-1 [html[data-liquid-glass]_&]:before:rounded-b-(--chat-composer-strip-radius) [html[data-liquid-glass]_&]:before:border [html[data-liquid-glass]_&]:before:border-t-0 [html[data-liquid-glass]_&]:before:border-(--chat-composer-outline) [html[data-liquid-glass]_&]:before:bg-(--chat-composer-glass-fill) [html[data-liquid-glass]_&]:before:composer-frost",
        "[html[data-liquid-glass]_&]:after:pointer-events-none [html[data-liquid-glass]_&]:after:absolute [html[data-liquid-glass]_&]:after:inset-x-(--chat-composer-drawer-inset,1.75rem) [html[data-liquid-glass]_&]:after:inset-y-0 [html[data-liquid-glass]_&]:after:-z-1 [html[data-liquid-glass]_&]:after:rounded-b-(--chat-composer-strip-radius) [html[data-liquid-glass]_&]:after:shadow-float [html[data-liquid-glass]_&]:after:[clip-path:inset(0_-100px_-100px_-100px)]",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:[html[data-liquid-glass]_&]:before:bg-(--chat-composer-glass-surface)",
        "[html[data-liquid-glass]_&]:group-data-liquid-glass-shaped/composer-surface:before:hidden [html[data-liquid-glass]_&]:group-data-liquid-glass-shaped/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
