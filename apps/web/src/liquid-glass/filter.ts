/**
 * Chromium is the only engine that runs an SVG filter over the backdrop, so the displacement
 * map cannot live in plain CSS: it needs each surface's pixel size to keep its rim uniform.
 */

const MAP_NEUTRAL = "#808080";
const BAND_RATIO = 0.14;
const MIN_BAND = 9;
const MAX_BAND = 18;
const DISPLACEMENT_RATIO = 3.4;
const DISPERSION = 1;
const RED_CHANNEL = "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0";
const GREEN_CHANNEL = "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0";
const BLUE_CHANNEL = "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0";

export interface LiquidGlassSurface {
  height: number;
  radius: number;
  width: number;
}

export interface LiquidGlassFilter {
  markup: string;
  /** Half the width of the band the surface bends, in pixels. */
  band: number;
}

/** The rim width that reads as thickness without eating a small surface. */
export function liquidGlassBand({ height, width }: LiquidGlassSurface): number {
  const ideal = Math.min(width, height) * BAND_RATIO;
  return Math.round(Math.min(MAX_BAND, Math.max(MIN_BAND, ideal)));
}

function buildMap(id: string, { height, radius, width }: LiquidGlassSurface, band: number) {
  const innerWidth = Math.max(0, width - band * 2);
  const innerHeight = Math.max(0, height - band * 2);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    `<linearGradient id="x-${id}"><stop stop-color="#000"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    `<linearGradient id="y-${id}" x2="0" y2="1"><stop stop-color="#000"/><stop offset="1" stop-color="#0f0"/></linearGradient>`,
    `<clipPath id="outline-${id}"><rect width="${width}" height="${height}" rx="${radius}"/></clipPath>`,
    `<filter id="soften-${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${band / 2}"/></filter>`,
    "</defs>",
    `<rect width="${width}" height="${height}" fill="${MAP_NEUTRAL}"/>`,
    `<g clip-path="url(#outline-${id})">`,
    `<rect width="${width}" height="${height}" fill="url(#x-${id})"/>`,
    `<rect width="${width}" height="${height}" fill="url(#y-${id})" style="mix-blend-mode:screen"/>`,
    `<rect x="${band}" y="${band}" width="${innerWidth}" height="${innerHeight}" fill="${MAP_NEUTRAL}" filter="url(#soften-${id})"/>`,
    "</g>",
    "</svg>",
  ].join("");
}

/** `red`, `green` and `blue` samples sit one pixel apart, which is the dispersion fringe. */
function buildPasses(scale: number) {
  return [RED_CHANNEL, GREEN_CHANNEL, BLUE_CHANNEL]
    .map(
      (matrix, index) =>
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale - DISPERSION + index}" xChannelSelector="B" yChannelSelector="G" result="displaced-${index}"/>` +
        `<feColorMatrix in="displaced-${index}" type="matrix" values="${matrix}" result="channel-${index}"/>`,
    )
    .join("");
}

export function buildLiquidGlassFilter(id: string, surface: LiquidGlassSurface): LiquidGlassFilter {
  const band = liquidGlassBand(surface);
  const scale = Math.round(band * DISPLACEMENT_RATIO);
  const map = buildMap(id, surface, band);
  const markup = [
    `<svg xmlns="http://www.w3.org/2000/svg"><filter id="${id}" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">`,
    `<feImage href="data:image/svg+xml,${encodeURIComponent(map)}" preserveAspectRatio="none" result="map"/>`,
    buildPasses(scale),
    `<feBlend in="channel-0" in2="channel-1" mode="screen" result="blended"/>`,
    `<feBlend in="blended" in2="channel-2" mode="screen"/>`,
    "</filter></svg>",
  ].join("");
  return { markup, band };
}

/** The whole `backdrop-filter` value, so one variable switches every glass surface at once. */
export function liquidGlassBackdropFilter(id: string): string {
  // Frost first: a displaced backdrop still has to read as glass over text, and the bend stays
  // visible because the blur is only softening what is already shifted.
  return `blur(var(--glass-blur)) saturate(var(--glass-saturation)) url(#${id}) blur(1px)`;
}
