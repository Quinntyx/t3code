import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

export interface LiquidGlassOptions {
  blur: number;
  centerBlur: number;
  saturation: number;
  refraction: number;
  dispersion: number;
  glare: number;
}

export const DEFAULT_LIQUID_GLASS_OPTIONS: LiquidGlassOptions = {
  blur: DEFAULT_UNIFIED_SETTINGS.liquidGlassBlur,
  centerBlur: DEFAULT_UNIFIED_SETTINGS.liquidGlassCenterBlur,
  saturation: DEFAULT_UNIFIED_SETTINGS.liquidGlassSaturation,
  refraction: DEFAULT_UNIFIED_SETTINGS.liquidGlassRefraction,
  dispersion: DEFAULT_UNIFIED_SETTINGS.liquidGlassDispersion,
  glare: DEFAULT_UNIFIED_SETTINGS.liquidGlassGlare,
};

// Filter parameters from https://blade04208.github.io/css/liquid-glass.css (lyra rebane).
const MAP_NEUTRAL = "#808080";
const RIM_WIDTH = 12;
const RED_CHANNEL = "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1";
const GREEN_CHANNEL = "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 1";
const BLUE_CHANNEL = "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0 1";

export interface LiquidGlassSurface {
  height: number;
  width: number;
  radius: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

function cornerRadius({ height, width, radius }: LiquidGlassSurface): number {
  return round(Math.max(0, Math.min(radius, width / 2, height / 2)));
}

function buildMap(id: string, surface: LiquidGlassSurface) {
  const { height, width } = surface;
  const radius = cornerRadius(surface);
  const innerWidth = Math.max(0, width - RIM_WIDTH * 2);
  const innerHeight = Math.max(0, height - RIM_WIDTH * 2);
  const innerRadius = round(Math.max(0, radius - RIM_WIDTH));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    `<linearGradient id="x-${id}"><stop stop-color="#000"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    `<linearGradient id="y-${id}" x2="0" y2="1"><stop stop-color="#000"/><stop offset="1" stop-color="#0f0"/></linearGradient>`,
    `<clipPath id="outline-${id}"><rect width="${width}" height="${height}" rx="${radius}"/></clipPath>`,
    `<filter id="soften-${id}" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="4"/></filter>`,
    "</defs>",
    `<rect width="${width}" height="${height}" fill="${MAP_NEUTRAL}"/>`,
    `<g clip-path="url(#outline-${id})">`,
    `<rect width="${width}" height="${height}" fill="url(#x-${id})"/>`,
    `<rect width="${width}" height="${height}" fill="url(#y-${id})" style="mix-blend-mode:screen"/>`,
    `<rect x="${RIM_WIDTH}" y="${RIM_WIDTH}" rx="${innerRadius}" width="${innerWidth}" height="${innerHeight}" fill="${MAP_NEUTRAL}" filter="url(#soften-${id})"/>`,
    "</g>",
    "</svg>",
  ].join("");
}

function buildPasses({ refraction, dispersion }: LiquidGlassOptions) {
  return [RED_CHANNEL, GREEN_CHANNEL, BLUE_CHANNEL]
    .map(
      (matrix, index) =>
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${((-20 + ((1 - index) * dispersion) / 100) * refraction) / 100}" xChannelSelector="B" yChannelSelector="G" result="displaced-${index}"/>` +
        `<feColorMatrix in="displaced-${index}" type="matrix" values="${matrix}" result="channel-${index}"/>`,
    )
    .join("");
}

/** White inside the rim, black over the interior the map leaves neutral. */
function buildRimMask(surface: LiquidGlassSurface) {
  const { height, width } = surface;
  const innerRadius = round(Math.max(0, cornerRadius(surface) - RIM_WIDTH));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<filter id="soften" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="4"/></filter>`,
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<rect x="${RIM_WIDTH}" y="${RIM_WIDTH}" rx="${innerRadius}" width="${Math.max(0, width - RIM_WIDTH * 2)}" height="${Math.max(0, height - RIM_WIDTH * 2)}" fill="#000" filter="url(#soften)"/>`,
    "</svg>",
  ].join("");
}

/**
 * The backdrop filter's trailing blur covers the whole surface at the edge radius, and gaussians
 * stack by variance, so the interior only needs the difference.
 */
export function liquidGlassCenterBlurExtra({ blur, centerBlur }: LiquidGlassOptions): number {
  return round(Math.sqrt(Math.max(0, centerBlur ** 2 - blur ** 2)));
}

function buildCenterBlur(surface: LiquidGlassSurface, extra: number) {
  if (extra <= 0) return "";
  return [
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${extra}" result="center-blurred"/>`,
    // Chromium ignores edgeMode here, so the blur fades past the box; the opaque backdrop refills it.
    `<feComposite in="center-blurred" in2="SourceGraphic" operator="over" result="center"/>`,
    `<feImage href="data:image/svg+xml,${encodeURIComponent(buildRimMask(surface))}" preserveAspectRatio="none" result="rim-luminance"/>`,
    `<feColorMatrix in="rim-luminance" type="luminanceToAlpha" result="rim"/>`,
    `<feComposite in="refracted" in2="rim" operator="in" result="edge"/>`,
    `<feComposite in="center" in2="rim" operator="out" result="interior"/>`,
    `<feComposite in="edge" in2="interior" operator="arithmetic" k2="1" k3="1"/>`,
  ].join("");
}

export function buildLiquidGlassFilter(
  id: string,
  surface: LiquidGlassSurface,
  options: Partial<LiquidGlassOptions> = {},
) {
  const resolved = { ...DEFAULT_LIQUID_GLASS_OPTIONS, ...options };
  const map = buildMap(id, surface);
  const markup = [
    `<svg xmlns="http://www.w3.org/2000/svg"><filter id="${id}" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">`,
    `<feImage href="data:image/svg+xml,${encodeURIComponent(map)}" preserveAspectRatio="none" result="map"/>`,
    buildPasses(resolved),
    `<feBlend in="channel-2" in2="channel-1" mode="screen" result="blended"/>`,
    `<feBlend in="blended" in2="channel-0" mode="screen"/>`,
    // Reconstruct straight RGB first; screening three copies of edge alpha creates a dark rim.
    `<feComposite in2="SourceAlpha" operator="in"/>`,
    `<feOffset dx="0.0392156862745" dy="0.0392156862745" result="refracted"/>`,
    buildCenterBlur(surface, liquidGlassCenterBlurExtra(resolved)),
    "</filter></svg>",
  ].join("");
  return { markup };
}

// Glare from iyinchao's liquid-glass-studio with the maintainer-tuned look: angle -117°,
// intensity 90%, convergence 50%, opposite side 80%, and a hard, thin edge.
const GLARE_ANGLE = (-117 * Math.PI) / 180;
const GLARE_INTENSITY = 0.9;
const GLARE_CONVERGENCE = 0.5;
const GLARE_OPPOSITE = 0.8;
const GLARE_CORE = 2;
const GLARE_COLOR = "#fff6de";
const GLARE_CORNER_STEPS = 8;

/** iyinchao's angular glare factor for an outward normal in screen coordinates. */
function glareFactor(normalX: number, normalY: number, strength: number): number {
  let angle = Math.atan2(-normalY, normalX);
  if (angle < 0) angle += Math.PI * 2;
  const glare = (angle - Math.PI / 4 + GLARE_ANGLE) * 2;
  const farSide = (glare > Math.PI * 1.5 && glare < Math.PI * 3.5) || glare < -Math.PI * 0.5;
  const factor =
    (0.5 + Math.sin(glare) * 0.5) * (farSide ? 1.2 * GLARE_OPPOSITE : 1.2) * GLARE_INTENSITY;
  return Math.min(1, Math.max(0, (factor * strength) ** (0.1 + GLARE_CONVERGENCE * 2)));
}

/** The outline as edge and corner-arc pieces, each lit by its own outward normal. */
function glarePieces({ height, width }: LiquidGlassSurface, radius: number, strength: number) {
  const pieces: string[] = [];
  const piece = (d: string, normalX: number, normalY: number) => {
    const level = Math.round(glareFactor(normalX, normalY, strength) * 255);
    pieces.push(`<path d="${d}" stroke="rgb(${level},${level},${level})"/>`);
  };
  const point = (x: number, y: number) => `${round(x)} ${round(y)}`;
  piece(`M${point(radius, 0)}L${point(width - radius, 0)}`, 0, -1);
  piece(`M${point(width, radius)}L${point(width, height - radius)}`, 1, 0);
  piece(`M${point(width - radius, height)}L${point(radius, height)}`, 0, 1);
  piece(`M${point(0, height - radius)}L${point(0, radius)}`, -1, 0);
  if (radius <= 0) return pieces.join("");
  for (const [centerX, centerY, start] of [
    [width - radius, radius, -Math.PI / 2],
    [width - radius, height - radius, 0],
    [radius, height - radius, Math.PI / 2],
    [radius, radius, Math.PI],
  ] as const) {
    for (let step = 0; step < GLARE_CORNER_STEPS; step += 1) {
      const from = start + (step / GLARE_CORNER_STEPS) * (Math.PI / 2);
      const to = start + ((step + 1) / GLARE_CORNER_STEPS) * (Math.PI / 2);
      const middle = (from + to) / 2;
      piece(
        `M${point(centerX + Math.cos(from) * radius, centerY + Math.sin(from) * radius)}A${round(radius)} ${round(radius)} 0 0 1 ${point(centerX + Math.cos(to) * radius, centerY + Math.sin(to) * radius)}`,
        Math.cos(middle),
        Math.sin(middle),
      );
    }
  }
  return pieces.join("");
}

/**
 * The rim light: a hard warm line lit per surface normal. No dark inner vignette: on light themes
 * it read as a grey halo around every glass surface.
 * Painted as a background layer, so the fill's opacity cannot wash it out.
 */
export function buildLiquidGlassGlare(
  surface: LiquidGlassSurface,
  options: Partial<LiquidGlassOptions> = {},
): string | null {
  const strength = ({ ...DEFAULT_LIQUID_GLASS_OPTIONS, ...options }.glare ?? 0) / 100;
  if (strength <= 0) return null;
  const { height, width } = surface;
  const radius = cornerRadius(surface);
  const inset = (amount: number) =>
    `x="${amount}" y="${amount}" width="${round(Math.max(0, width - amount * 2))}" height="${round(Math.max(0, height - amount * 2))}" rx="${round(Math.max(0, radius - amount))}"`;
  const edgeMask = (id: string, amount: number, softness: number) =>
    [
      `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">`,
      `<rect ${inset(0)} fill="#fff"/>`,
      `<rect ${inset(amount)} fill="#000" filter="url(#${id}-soft)"/>`,
      "</mask>",
      `<filter id="${id}-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${softness}"/></filter>`,
    ].join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    edgeMask("core", GLARE_CORE, 0.35),
    `<filter id="smooth" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.5"/></filter>`,
    `<mask id="angle" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">`,
    `<g fill="none" stroke-width="10" filter="url(#smooth)">${glarePieces(surface, radius, strength)}</g>`,
    "</mask>",
    "</defs>",
    `<g mask="url(#angle)"><rect ${inset(0)} fill="${GLARE_COLOR}" mask="url(#core)"/></g>`,
    "</svg>",
  ].join("");
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function liquidGlassBackdropFilter(
  id: string,
  options: Partial<LiquidGlassOptions> = {},
): string {
  const { blur, saturation } = { ...DEFAULT_LIQUID_GLASS_OPTIONS, ...options };
  return `blur(0px) url(#${id}) blur(${blur}px)${saturation === 100 ? "" : ` saturate(${saturation / 100})`}`;
}
