import { observeResize } from "~/lib/observeResize";

import {
  buildLiquidGlassFilter,
  buildLiquidGlassGlare,
  buildOutlineGlare,
  buildOutlineMasks,
  DEFAULT_LIQUID_GLASS_OPTIONS,
  liquidGlassBackdropFilter,
  liquidGlassCenterBlurExtra,
  type LiquidGlassOptions,
  type LiquidGlassSurface,
} from "./filter";
import {
  buildGlassGeometry,
  type GlassGeometry,
  type LiquidGlassPart,
  type LiquidGlassShape,
} from "./shape";

const GLASS_SELECTOR =
  ".surface-glass, .panel-glass, .alert-glass, .dialog-glass, .dropdown-glass, [data-liquid-glass], [data-composer-banner-surface]";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MIN_SIZE = 16;
const MAX_AREA = 2_000_000;
const RESIZE_SETTLE_MS = 120;

interface Outline {
  fill: string;
  ring: string;
  /** CSS inset of the outline's box from the element's border box. */
  inset: readonly [top: number, right: number, bottom: number, left: number];
  merged: readonly Element[];
}

interface Surface {
  element: Element;
  id: string;
  filter?: Element;
  glare: string | null;
  outline: Outline | null;
  key: string;
  timer: number;
  unobserve: () => void;
}

/** A part in element-local CSS pixels; `element` is drawn by this glass instead of its own. */
export interface LiquidGlassShapePart extends LiquidGlassPart {
  element?: Element;
}

/** Returns the parts the element's glass is made of, or null to keep its plain rounded rect. */
export type LiquidGlassShapeProvider = () => readonly LiquidGlassShapePart[] | null;

const shapeProviders = new WeakMap<Element, LiquidGlassShapeProvider>();
let scheduleActive: ((element: Element) => void) | null = null;

/** Gives an element glass shaped from several parts; see `shape.ts`. */
export function setLiquidGlassShape(element: Element, provider: LiquidGlassShapeProvider | null) {
  if (provider) shapeProviders.set(element, provider);
  else shapeProviders.delete(element);
  scheduleActive?.(element);
}

/** Rebuilds an element's glass on the next frame, for changes its own size does not reveal. */
export function invalidateLiquidGlass(element: Element) {
  scheduleActive?.(element);
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

const INSET_PROPERTIES = [
  "--glass-liquid-top",
  "--glass-liquid-right",
  "--glass-liquid-bottom",
  "--glass-liquid-left",
] as const;

function paintOutline(element: Element, next: Outline | null, previous: Outline | null) {
  const style = (element as HTMLElement).style;
  for (const part of previous?.merged ?? []) {
    if (!next?.merged.includes(part)) part.removeAttribute("data-liquid-glass-merged");
  }
  if (!next) {
    element.removeAttribute("data-liquid-glass-shaped");
    style.removeProperty("--glass-liquid-mask");
    style.removeProperty("--glass-liquid-outline");
    for (const property of INSET_PROPERTIES) style.removeProperty(property);
    return;
  }
  style.setProperty("--glass-liquid-mask", next.fill);
  style.setProperty("--glass-liquid-outline", next.ring);
  INSET_PROPERTIES.forEach((property, index) =>
    style.setProperty(property, `${next.inset[index] ?? 0}px`),
  );
  element.setAttribute("data-liquid-glass-shaped", "");
  for (const part of next.merged) part.setAttribute("data-liquid-glass-merged", "");
}

function paint(element: Element, id: string, glare: string | null, options: LiquidGlassOptions) {
  const style = (element as HTMLElement).style;
  style.setProperty("--glass-liquid-filter", liquidGlassBackdropFilter(id, options));
  if (glare) style.setProperty("--glass-liquid-glare", glare);
  else style.removeProperty("--glass-liquid-glare");
}

const tenth = (value: number) => Math.round(value * 10) / 10;

/** Moves element-local parts into their own bounding box. */
function measureShape(element: Element, parts: readonly LiquidGlassShapePart[]) {
  const rect = element.getBoundingClientRect();
  const left = Math.floor(Math.min(...parts.map((part) => part.x)));
  const top = Math.floor(Math.min(...parts.map((part) => part.y)));
  const right = Math.ceil(Math.max(...parts.map((part) => part.x + part.width)));
  const bottom = Math.ceil(Math.max(...parts.map((part) => part.y + part.height)));
  const shape: LiquidGlassShape = {
    width: right - left,
    height: bottom - top,
    parts: parts.map((part) => ({
      x: tenth(part.x - left),
      y: tenth(part.y - top),
      width: tenth(part.width),
      height: tenth(part.height),
      radius: tenth(part.radius),
      fillet: tenth(part.fillet),
    })),
  };
  if (shape.width < MIN_SIZE || shape.height < MIN_SIZE) return null;
  if (shape.width * shape.height > MAX_AREA) return null;
  const inset = [top, rect.width - right, rect.height - bottom, left] as const;
  return { shape, inset };
}

function encodeMap({ pixels, width, height }: GlassGeometry["map"]): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL();
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
    paintOutline(element, null, surface.outline);
    surfaces.delete(element);
  };

  const build = (element: Element, id: string) => {
    const parts = shapeProviders.get(element)?.() ?? null;
    const shaped = parts?.length ? measureShape(element, parts) : null;
    if (shaped && parts) {
      const { shape, inset } = shaped;
      return {
        key: `${JSON.stringify(shape)}:${inset.join(",")}`,
        create: () => {
          const { map, ...outline } = buildGlassGeometry(shape);
          const masks = buildOutlineMasks({ ...shape, path: outline.path });
          return {
            glare: buildOutlineGlare({ ...shape, ...outline }, options),
            markup: buildLiquidGlassFilter(id, { ...shape, radius: 0 }, options, encodeMap(map))
              .markup,
            outline: {
              ...masks,
              inset,
              merged: parts.flatMap((part) => (part.element ? [part.element] : [])),
            },
          };
        },
      };
    }
    const geometry = measure(element);
    if (!geometry) return null;
    return {
      key: `${geometry.width}x${geometry.height}r${geometry.radius}`,
      create: () => ({
        glare: buildLiquidGlassGlare(geometry, options),
        markup: buildLiquidGlassFilter(id, geometry, options).markup,
        outline: null,
      }),
    };
  };

  const render = (element: Element) => {
    const id = `liquid-glass-${sequence + 1}`;
    const plan = build(element, id);
    if (!plan) {
      release(element);
      return;
    }
    const key = `${plan.key}:${options.refraction}:${options.dispersion}:${options.glare}:${liquidGlassCenterBlurExtra(options)}`;
    const existing = surfaces.get(element);
    if (existing?.key === key && existing.filter) {
      paint(element, existing.id, existing.glare, options);
      return;
    }

    sequence += 1;
    const { glare, markup, outline } = plan.create();
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
        outline: null,
        key,
        timer: 0,
        unobserve: observeResize(element, () => {
          window.clearTimeout(surface.timer);
          surface.timer = window.setTimeout(() => schedule(element), RESIZE_SETTLE_MS);
        }),
      } satisfies Surface);
    paintOutline(element, outline, surface.outline);
    surface.id = id;
    surface.glare = glare;
    surface.outline = outline;
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
  scheduleActive = schedule;

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
      if (scheduleActive === schedule) scheduleActive = null;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const element of surfaces.keys()) release(element);
      root.remove();
    },
  };
}
