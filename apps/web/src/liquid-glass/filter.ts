import type { LiquidGlassField } from "./field";
import type { LiquidGlassTuning } from "./tuning";

const CHANNEL_MATRICES = [
  // keep the red channel
  "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0",
  // keep the green channel
  "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0",
  // keep the blue channel
  "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0",
] as const;

const DISPLACED_CHANNELS = ["dispR", "dispG", "dispB"] as const;

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/**
 * Backdrop value the engine installs on a surface. The frost's blur is applied inside the filter,
 * before the displacement, so nothing is left to combine here.
 */
export function liquidGlassBackdropFilter(filterId: string): string {
  return `url(#${filterId}) saturate(var(--glass-saturation))`;
}

function displacementNodes(
  source: string,
  scale: number,
  spread: number,
  tuning: LiquidGlassTuning,
): string {
  if (tuning.dispersion <= 0) {
    return `<feDisplacementMap in="${source}" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>`;
  }

  const scales = [scale * (1 + spread), scale, scale * (1 - spread)];
  const dispersed = scales.map(
    (channelScale, index) =>
      `<feDisplacementMap in="${source}" in2="map" scale="${channelScale.toFixed(3)}" xChannelSelector="R" yChannelSelector="G" result="${DISPLACED_CHANNELS[index]}"/>` +
      `<feColorMatrix in="${DISPLACED_CHANNELS[index]}" type="matrix" values="${CHANNEL_MATRICES[index]}" result="chan${index}"/>`,
  );

  return `${dispersed.join("")}<feBlend in="chan0" in2="chan1" mode="screen" result="dispRG"/><feBlend in="dispRG" in2="chan2" mode="screen" result="displaced"/>`;
}

/**
 * The frost's blur lives inside the filter: a filter list cannot mix a `url()` reference with
 * functions here (Chromium renders only the reference), and blurring the displaced backdrop
 * would smear the bend. Softening the source instead keeps the refraction legible.
 */
export function buildLiquidGlassFilterMarkup(
  filterId: string,
  field: LiquidGlassField,
  tuning: LiquidGlassTuning,
  imageHref: string,
  blurRadius: number,
): string {
  const spread = tuning.dispersion / 100;
  const soften = blurRadius > 0;
  const source = soften ? "soft" : "SourceGraphic";
  return [
    `<filter id="${filterId}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`,
    `<feImage href="${escapeAttribute(imageHref)}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>`,
    soften
      ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${blurRadius}" edgeMode="duplicate" result="soft"/>`
      : "",
    displacementNodes(source, field.scale, spread, tuning),
    `<feColorMatrix in="map" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 1 0 0" result="specular"/>`,
    `<feComposite in="specular" in2="displaced" operator="over"/>`,
    `</filter>`,
  ].join("");
}
