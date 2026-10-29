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

/** Backdrop value the engine installs on a surface, keeping the existing frost behind it. */
export function liquidGlassBackdropFilter(filterId: string): string {
  return `url(#${filterId}) blur(var(--glass-blur)) saturate(var(--glass-saturation))`;
}

function displacementNodes(scale: number, spread: number, tuning: LiquidGlassTuning): string {
  if (tuning.dispersion <= 0) {
    return `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>`;
  }

  const scales = [scale * (1 + spread), scale, scale * (1 - spread)];
  const dispersed = scales.map(
    (channelScale, index) =>
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${channelScale.toFixed(3)}" xChannelSelector="R" yChannelSelector="G" result="${DISPLACED_CHANNELS[index]}"/>` +
      `<feColorMatrix in="${DISPLACED_CHANNELS[index]}" type="matrix" values="${CHANNEL_MATRICES[index]}" result="chan${index}"/>`,
  );

  return `${dispersed.join("")}<feBlend in="chan0" in2="chan1" mode="screen" result="dispRG"/><feBlend in="dispRG" in2="chan2" mode="screen" result="displaced"/>`;
}

export function buildLiquidGlassFilterMarkup(
  filterId: string,
  field: LiquidGlassField,
  tuning: LiquidGlassTuning,
  imageHref: string,
): string {
  const spread = tuning.dispersion / 100;
  return [
    `<filter id="${filterId}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`,
    `<feImage href="${escapeAttribute(imageHref)}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>`,
    displacementNodes(field.scale, spread, tuning),
    `<feColorMatrix in="map" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 1 0 0" result="specular"/>`,
    `<feComposite in="specular" in2="displaced" operator="over"/>`,
    `</filter>`,
  ].join("");
}
