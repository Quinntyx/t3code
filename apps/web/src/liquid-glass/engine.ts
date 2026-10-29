import { buildLiquidGlassField } from "./field";
import { buildLiquidGlassFilterMarkup, liquidGlassBackdropFilter } from "./filter";
import { LIQUID_GLASS_DEFAULT_TUNING, type LiquidGlassTuning } from "./tuning";
import { observeResize } from "~/lib/observeResize";

const GLASS_SELECTOR =
  ".surface-glass, .alert-glass, .dialog-glass, .dropdown-glass, [data-liquid-glass], [data-composer-banner-surface]";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MIN_SIZE = 16;
const MAX_AREA = 2_000_000;
const SOFTEN_FACTOR = 0.5;
const MAX_SOFTEN = 8;

interface Surface {
  key: string;
  unobserve: () => void;
  timer: number;
  filter?: Element;
  imageUrl?: string;
}

const RESIZE_SETTLE_MS = 120;

function supportsLiquidGlass(): boolean {
  if (typeof window === "undefined" || typeof OffscreenCanvas === "undefined") return false;
  if (!/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent)) return false;
  return window.CSS?.supports("backdrop-filter", "url(#liquid-glass)") === true;
}

function softenRadius(element: Element): number {
  const amount = Number.parseFloat(getComputedStyle(element).getPropertyValue("--glass-blur"));
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.min(MAX_SOFTEN, Math.round(amount * SOFTEN_FACTOR * 10) / 10);
}

function cornerRadius(element: Element, width: number, height: number): number {
  const value = getComputedStyle(element).borderTopLeftRadius;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  if (!value.trim().endsWith("%")) return Math.max(0, amount);
  return amount >= 50 ? Math.min(width, height) / 2 : (amount / 100) * Math.min(width, height);
}

async function encodeField(pixels: Uint8ClampedArray, width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = new ImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}

export interface LiquidGlassController {
  update(tuning: LiquidGlassTuning): void;
  stop(): void;
}

/**
 * Turns every frosted surface into refracting glass by assigning each one a generated
 * displacement map as `backdrop-filter`. Chromium-only: it is the only engine that runs
 * an SVG filter over the backdrop.
 */
export function startLiquidGlass(
  tuning: LiquidGlassTuning = LIQUID_GLASS_DEFAULT_TUNING,
): LiquidGlassController {
  if (!supportsLiquidGlass()) return { update: () => {}, stop: () => {} };
  let active = tuning;

  const root = document.createElementNS(SVG_NAMESPACE, "svg");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("width", "0");
  root.setAttribute("height", "0");
  root.style.cssText = "position:fixed;left:0;top:0;overflow:hidden;pointer-events:none";
  document.body.append(root);

  const surfaces = new Map<Element, Surface>();
  const attempts = new WeakMap<Element, number>();
  let queued = new Set<Element>();
  let sequence = 0;
  let frame = 0;

  const release = (element: Element) => {
    const surface = surfaces.get(element);
    if (!surface) return;
    surface.unobserve();
    window.clearTimeout(surface.timer);
    surface.filter?.remove();
    if (surface.imageUrl) URL.revokeObjectURL(surface.imageUrl);
    (element as HTMLElement).style.removeProperty("--glass-liquid-filter");
    surfaces.delete(element);
  };

  const render = async (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE || rect.width * rect.height > MAX_AREA) {
      release(element);
      return;
    }

    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const radius = cornerRadius(element, width, height);
    const soften = softenRadius(element);
    const key = `${width}x${height}x${Math.round(radius)}x${soften}`;
    const existing = surfaces.get(element);
    if (existing?.key === key && existing.filter) return;

    const attempt = (attempts.get(element) ?? 0) + 1;
    attempts.set(element, attempt);
    const field = buildLiquidGlassField({ width, height, radius }, active);
    const imageUrl = await encodeField(field.pixels, width, height);
    if (attempts.get(element) !== attempt || !element.isConnected) {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      return;
    }
    if (!imageUrl) return;

    const filterId = `liquid-glass-${++sequence}`;
    root.insertAdjacentHTML(
      "beforeend",
      buildLiquidGlassFilterMarkup(filterId, field, active, imageUrl, soften),
    );
    const filter = root.lastElementChild;
    if (!filter) {
      URL.revokeObjectURL(imageUrl);
      return;
    }

    existing?.filter?.remove();
    if (existing?.imageUrl) URL.revokeObjectURL(existing.imageUrl);
    const surface: Surface = existing ?? { key, unobserve: () => {}, timer: 0 };
    if (!existing) {
      surface.unobserve = observeResize(element, () => {
        if (!surface.filter) {
          schedule(element);
          return;
        }
        window.clearTimeout(surface.timer);
        surface.timer = window.setTimeout(() => schedule(element), RESIZE_SETTLE_MS);
      });
    }
    surface.key = key;
    surface.filter = filter;
    surface.imageUrl = imageUrl;
    surfaces.set(element, surface);
    (element as HTMLElement).style.setProperty(
      "--glass-liquid-filter",
      liquidGlassBackdropFilter(filterId),
    );
  };

  const flush = () => {
    frame = 0;
    const batch = queued;
    queued = new Set();
    for (const element of batch) {
      if (element.isConnected) void render(element);
      else release(element);
    }
    for (const element of surfaces.keys()) {
      if (!element.isConnected) release(element);
    }
  };

  function schedule(element: Element) {
    queued.add(element);
    if (!frame) frame = requestAnimationFrame(flush);
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
        if (element.firstElementChild) {
          for (const child of element.querySelectorAll(GLASS_SELECTOR)) adopt(child);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const update = (next: LiquidGlassTuning) => {
    active = next;
    for (const [element, surface] of surfaces) {
      surface.key = "";
      schedule(element);
    }
  };

  const stop = () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    for (const element of surfaces.keys()) release(element);
    root.remove();
  };

  return { update, stop };
}
