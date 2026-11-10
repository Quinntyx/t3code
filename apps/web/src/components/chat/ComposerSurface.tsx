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
        "[--chat-composer-glass-fill:color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--glass-opacity),transparent)] [--glass-liquid-edge:var(--chat-composer-outline)]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-(--chat-composer-radius) before:bg-(--chat-composer-glass-fill) before:composer-frost before:glass-glare",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden",
        contextRow && [
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
          "[--chat-composer-drawer-padding:calc(var(--chat-composer-drawer-inset)+0.5rem)]",
          // The context strip draws its own surface below the card, so the glass stops at the card.
          "before:bottom-(--chat-composer-context-extension)",
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

// The strip carries the body's lower edge, so the card's own bottom outline stops where it starts.
const contextSeamClasses =
  "group-data-[context-row=true]/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-var(--chat-composer-drawer-inset))_100%,calc(100%-var(--chat-composer-drawer-inset))_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%-2px),var(--chat-composer-drawer-inset)_100%,0_100%)]";

// Everything but the strip's footprint, so the card's shadow stops at the seam instead of crossing
// it, and the strip draws the body's shadow from there down. Clipped on ::before: a clip-path on
// the host would make it a backdrop root and strip the frost from banners and the card inside it.
const contextShadowClasses =
  "group-data-[context-row=true]/composer-surface:before:[clip-path:polygon(-100px_-100px,calc(100%_+_100px)_-100px,calc(100%_+_100px)_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%_+_100px),-100px_calc(100%_+_100px))]";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-(--chat-composer-radius) after:z-1",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] before:shadow-float",
        outlineClasses,
        contextSeamClasses,
        contextShadowClasses,
        // Shaped liquid glass draws the outline and one body shadow around the drawers and strip.
        "group-data-liquid-glass-shaped/composer-surface:before:hidden",
        "group-data-liquid-glass-shaped/composer-surface:after:hidden",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:before:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
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
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-float",
        // The host's seam clip, here because the card's shadow and outline move here. Main's own
        // frost already makes it a backdrop root, so the clip-path costs nothing.
        "group-data-[context-row=true]/composer-surface:group-has-data-[composer-banner-surface=attached]/composer-surface:[clip-path:polygon(-100px_-100px,calc(100%_+_100px)_-100px,calc(100%_+_100px)_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%_+_100px),calc(100%-var(--chat-composer-drawer-inset))_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%-2px),var(--chat-composer-drawer-inset)_calc(100%_+_100px),-100px_calc(100%_+_100px))]",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The row under the card (environment, worktree, branch), drawn as the card's attached surface:
 * the same fill, outline and corners as a banner above it, meeting the card's bottom edge.
 */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative isolate z-20 flex h-(--chat-composer-context-extension) w-full items-center gap-2 overflow-x-clip px-(--chat-composer-drawer-padding,2.25rem) text-muted-foreground",
        "before:pointer-events-none before:absolute before:inset-x-(--chat-composer-drawer-inset,1.75rem) before:inset-y-0 before:-z-1 before:rounded-b-glass before:border before:border-t-0 before:border-(--chat-composer-outline) before:bg-(--chat-composer-glass-fill) before:composer-frost",
        // The strip's share of the body's shadow sits on its own layer, so shaped liquid glass can
        // draw the fill while the shadow still closes the body's lower edge. Kept off the card.
        "after:pointer-events-none after:absolute after:inset-x-(--chat-composer-drawer-inset,1.75rem) after:inset-y-0 after:-z-1 after:rounded-b-glass after:shadow-float after:[clip-path:inset(0_-100px_-100px_-100px)]",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        // Shaped liquid glass draws the strip as part of the card's body instead.
        "group-data-liquid-glass-shaped/composer-surface:before:hidden group-data-liquid-glass-shaped/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
