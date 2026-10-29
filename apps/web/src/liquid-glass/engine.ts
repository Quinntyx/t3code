import { observeResize } from "~/lib/observeResize";

import {
  buildLiquidGlassFilter,
  buildLiquidGlassGlare,
  DEFAULT_LIQUID_GLASS_OPTIONS,
  liquidGlassBackdropFilter,
  liquidGlassCenterBlurExtra,
  type LiquidGlassOptions,
  type LiquidGlassSurface,
} from "./filter";

const GLASS_SELECTOR =
  ".surface-glass, .alert-glass, .dialog-glass, .dropdown-glass, [data-liquid-glass], [data-composer-banner-surface]";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MIN_SIZE = 16;
const MAX_AREA = 2_000_000;
const RESIZE_SETTLE_MS = 120;

interface Surface {
  element: Element;
  id: string;
  filter?: Element;
  glare: string | null;
  key: string;
  timer: number;
  unobserve: () => void;
}

export interface LiquidGlassController {
  update(options: LiquidGlassOptions): void;
  stop(): void;
}

function supportsLiquidGlass(): boolean {
  if (typeof window === "undefined") return false;
  if (!/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent)) return false;
  return window.CSS?.supports("backdrop-filter", "url(#liquid-glass)") === true;
}

function measure(element: Element): LiquidGlassSurface | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return null;
  if (rect.width * rect.height > MAX_AREA) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  // The composer draws its rounded surface on ::before, leaving the shell itself square.
  const radius =
    parseFloat(getComputedStyle(element).borderTopLeftRadius) ||
    parseFloat(getComputedStyle(element, "::before").borderTopLeftRadius) ||
    0;
  return { width, height, radius };
}

function paint(element: Element, id: string, glare: string | null, options: LiquidGlassOptions) {
  const style = (element as HTMLElement).style;
  style.setProperty("--glass-liquid-filter", liquidGlassBackdropFilter(id, options));
  if (glare) style.setProperty("--glass-liquid-glare", glare);
  else style.removeProperty("--glass-liquid-glare");
}

/**
 * Gives every frosted surface a generated displacement map, so its backdrop bends instead of
 * only blurring. Chromium-only: no other engine runs an SVG filter over the backdrop.
 */
export function startLiquidGlass(
  initialOptions: LiquidGlassOptions = DEFAULT_LIQUID_GLASS_OPTIONS,
): LiquidGlassController {
  if (!supportsLiquidGlass()) return { update: () => {}, stop: () => {} };
  let options = initialOptions;

  const root = document.createElementNS(SVG_NAMESPACE, "svg");
  root.setAttribute("aria-hidden", "true");
  root.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden";
  document.body.append(root);

  const surfaces = new Map<Element, Surface>();
  let queued = new Set<Element>();
  let sequence = 0;
  let frame = 0;

  const release = (element: Element) => {
    const surface = surfaces.get(element);
    if (!surface) return;
    surface.unobserve();
    window.clearTimeout(surface.timer);
    surface.filter?.remove();
    (element as HTMLElement).style.removeProperty("--glass-liquid-filter");
    (element as HTMLElement).style.removeProperty("--glass-liquid-glare");
    surfaces.delete(element);
  };

  const render = (element: Element) => {
    const geometry = measure(element);
    if (!geometry) {
      release(element);
      return;
    }
    const key = `${geometry.width}x${geometry.height}r${geometry.radius}:${options.refraction}:${options.dispersion}:${options.glare}:${liquidGlassCenterBlurExtra(options)}`;
    const existing = surfaces.get(element);
    if (existing?.key === key && existing.filter) {
      paint(element, existing.id, existing.glare, options);
      return;
    }

    const id = `liquid-glass-${++sequence}`;
    const glare = buildLiquidGlassGlare(geometry, options);
    const { markup } = buildLiquidGlassFilter(id, geometry, options);
    root.insertAdjacentHTML("beforeend", markup);
    const filter = root.lastElementChild;
    if (!filter) return;

    existing?.filter?.remove();
    const surface: Surface =
      existing ??
      ({
        element,
        id,
        glare,
        key,
        timer: 0,
        unobserve: observeResize(element, () => {
          window.clearTimeout(surface.timer);
          surface.timer = window.setTimeout(() => schedule(element), RESIZE_SETTLE_MS);
        }),
      } satisfies Surface);
    surface.id = id;
    surface.glare = glare;
    surface.key = key;
    surface.filter = filter;
    surfaces.set(element, surface);
    paint(element, id, glare, options);
  };

  function schedule(element: Element) {
    queued.add(element);
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        const batch = queued;
        queued = new Set();
        for (const element of batch) {
          if (element.isConnected) render(element);
          else release(element);
        }
        for (const element of surfaces.keys()) {
          if (!element.isConnected) release(element);
        }
      });
    }
  }

  const adopt = (element: Element) => {
    if (!surfaces.has(element)) schedule(element);
  };

  for (const element of document.querySelectorAll(GLASS_SELECTOR)) adopt(element);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) release(node as Element);
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const element = node as Element;
        if (element.matches(GLASS_SELECTOR)) adopt(element);
        for (const child of element.querySelectorAll(GLASS_SELECTOR)) adopt(child);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    update: (next) => {
      if (
        options.blur === next.blur &&
        options.centerBlur === next.centerBlur &&
        options.saturation === next.saturation &&
        options.refraction === next.refraction &&
        options.dispersion === next.dispersion &&
        options.glare === next.glare
      )
        return;
      options = next;
      for (const element of surfaces.keys()) schedule(element);
    },
    stop: () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const element of surfaces.keys()) release(element);
      root.remove();
    },
  };
}
