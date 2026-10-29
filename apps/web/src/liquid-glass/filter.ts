// Filter parameters from https://blade04208.github.io/css/liquid-glass.css (lyra rebane).
const MAP_NEUTRAL = "#808080";
const RIM_WIDTH = 12;
const RED_CHANNEL = "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1";
const GREEN_CHANNEL = "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 1";
const BLUE_CHANNEL = "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0 1";

export interface LiquidGlassSurface {
  height: number;
  width: number;
}

function buildMap(id: string, { height, width }: LiquidGlassSurface) {
  const innerWidth = Math.max(0, width - RIM_WIDTH * 2);
  const innerHeight = Math.max(0, height - RIM_WIDTH * 2);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<defs>",
    `<linearGradient id="x-${id}"><stop stop-color="#000"/><stop offset="1" stop-color="#00f"/></linearGradient>`,
    `<linearGradient id="y-${id}" x2="0" y2="1"><stop stop-color="#000"/><stop offset="1" stop-color="#0f0"/></linearGradient>`,
    `<clipPath id="outline-${id}"><rect width="${width}" height="${height}" rx="8"/></clipPath>`,
    `<filter id="soften-${id}" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="4"/></filter>`,
    "</defs>",
    `<rect width="${width}" height="${height}" fill="${MAP_NEUTRAL}"/>`,
    `<g clip-path="url(#outline-${id})">`,
    `<rect width="${width}" height="${height}" fill="url(#x-${id})"/>`,
    `<rect width="${width}" height="${height}" fill="url(#y-${id})" style="mix-blend-mode:screen"/>`,
    `<rect x="${RIM_WIDTH}" y="${RIM_WIDTH}" rx="0" width="${innerWidth}" height="${innerHeight}" fill="${MAP_NEUTRAL}" filter="url(#soften-${id})"/>`,
    "</g>",
    "</svg>",
  ].join("");
}

function buildPasses() {
  return [RED_CHANNEL, GREEN_CHANNEL, BLUE_CHANNEL]
    .map(
      (matrix, index) =>
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${-19 - index}" xChannelSelector="B" yChannelSelector="G" result="displaced-${index}"/>` +
        `<feColorMatrix in="displaced-${index}" type="matrix" values="${matrix}" result="channel-${index}"/>`,
    )
    .join("");
}

export function buildLiquidGlassFilter(id: string, surface: LiquidGlassSurface) {
  const map = buildMap(id, surface);
  const markup = [
    `<svg xmlns="http://www.w3.org/2000/svg"><filter id="${id}" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">`,
    `<feImage href="data:image/svg+xml,${encodeURIComponent(map)}" preserveAspectRatio="none" result="map"/>`,
    buildPasses(),
    `<feBlend in="channel-2" in2="channel-1" mode="screen" result="blended"/>`,
    `<feBlend in="blended" in2="channel-0" mode="screen"/>`,
    // Reconstruct straight RGB first; screening three copies of edge alpha creates a dark rim.
    `<feComposite in2="SourceAlpha" operator="in"/>`,
    `<feOffset dx="0.0392156862745" dy="0.0392156862745"/>`,
    "</filter></svg>",
  ].join("");
  return { markup };
}

export function liquidGlassBackdropFilter(id: string): string {
  return `blur(0px) url(#${id}) blur(1px)`;
}
