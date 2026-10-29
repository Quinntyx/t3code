import { observeResize } from "~/lib/observeResize";
import { invalidateLiquidGlass, type LiquidGlassShapePart } from "~/liquid-glass/engine";

// Drawers blend into the composer through a concave fillet, like liquid-glass-studio's merge.
const DRAWER_FILLET = 12;
// Matches the context strip's corners in ComposerSurface's clip path.
const CONTEXT_STRIP_RADIUS = 16;

const drawers = new WeakMap<Element, Set<Element>>();

export function composerDrawerInset(element: Element): number {
  const rootFontSizePx =
    Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  const insetRem = Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue("--chat-composer-drawer-inset"),
  );
  return insetRem * rootFontSizePx;
}

/** Makes a drawer part of the composer's liquid glass while it is mounted. */
export function attachComposerDrawer(shell: Element, drawer: Element): () => void {
  const attached = drawers.get(shell) ?? new Set();
  drawers.set(shell, attached);
  attached.add(drawer);
  invalidateLiquidGlass(shell);
  const stopObserving = observeResize(drawer, () => invalidateLiquidGlass(shell));
  return () => {
    stopObserving();
    attached.delete(drawer);
    invalidateLiquidGlass(shell);
  };
}

/** The composer card, its context strip, and any open drawers, as one glass body. */
export function composerGlassShape(shell: HTMLElement): LiquidGlassShapePart[] | null {
  // Attached banners and the model strip transition move the frost off the shell.
  if (window.getComputedStyle(shell, "::before").display === "none") return null;
  const box = shell.getBoundingClientRect();
  const host = shell.querySelector('[data-slot="composer-host"]');
  if (!host) return null;
  const card = host.getBoundingClientRect();
  // Attachments reach the card's middle: a rounded union only reads as interior where one part
  // is deep, so a shallow overlap would leave a faint rim along the joint.
  const cardMiddle = card.top + card.height / 2 - box.top;
  const parts: LiquidGlassShapePart[] = [
    {
      x: card.left - box.left,
      y: card.top - box.top,
      width: card.width,
      height: card.height,
      radius: Number.parseFloat(window.getComputedStyle(host).borderTopLeftRadius) || 0,
      fillet: 0,
    },
  ];
  if (shell.dataset.contextRow) {
    const inset = composerDrawerInset(shell);
    parts.push({
      x: inset,
      y: cardMiddle,
      width: box.width - inset * 2,
      height: box.height - cardMiddle,
      radius: CONTEXT_STRIP_RADIUS,
      fillet: 0,
    });
  }
  for (const drawer of drawers.get(shell) ?? []) {
    const rect = drawer.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const surface = drawer.querySelector("[data-composer-banner-surface]") ?? drawer;
    parts.push({
      x: rect.left - box.left,
      y: rect.top - box.top,
      width: rect.width,
      height: Math.max(rect.height, cardMiddle - (rect.top - box.top)),
      radius:
        Number.parseFloat(window.getComputedStyle(surface, "::before").borderTopLeftRadius) || 0,
      fillet: DRAWER_FILLET,
      element: drawer,
    });
  }
  return parts;
}
