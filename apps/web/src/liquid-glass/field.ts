import { REFERENCE_HEIGHT, type LiquidGlassTuning } from "./tuning";

export interface LiquidGlassSurface {
  width: number;
  height: number;
  radius: number;
}

/**
 * One RGBA image carries the whole effect: R/G are the refraction offsets that
 * `feDisplacementMap` samples with, B is the white specular rim and glare overlay.
 */
export interface LiquidGlassField {
  width: number;
  height: number;
  /** Width of the refracting band along the edge, in CSS pixels. */
  band: number;
  /** Largest sample offset the map asks for, in CSS pixels. */
  maxDisplacement: number;
  /** `feDisplacementMap` scale that turns a channel value into `maxDisplacement`. */
  scale: number;
  pixels: Uint8ClampedArray;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function roundedRectDistance(
  px: number,
  py: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const qx = Math.abs(px) - (halfWidth - radius);
  const qy = Math.abs(py) - (halfHeight - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function specularAlpha(
  offsetX: number,
  offsetY: number,
  edgeDistance: number,
  height: number,
  tuning: LiquidGlassTuning,
  rimWidth: number,
): number {
  const scale = height / REFERENCE_HEIGHT;
  const rim = clamp01(1 - edgeDistance / rimWidth);
  const fresnel =
    Math.pow(rim, 1 / (0.2 + tuning.fresnelHardness / 100)) * (tuning.fresnelFactor / 100);

  const angle = (tuning.glareAngle * Math.PI) / 180;
  const perpendicular = offsetX * Math.sin(angle) - offsetY * Math.cos(angle);
  const travel = (0.5 - tuning.glareConvergence / 100) * height * 0.5;
  const range = Math.max(2, tuning.glareRange * scale * 0.5);
  const hardness = 1 / (0.15 + tuning.glareHardness / 100);
  let glare = 0;
  for (const center of [-travel, travel]) {
    const band = clamp01(1 - Math.abs(perpendicular - center) / range);
    glare = Math.max(glare, Math.pow(band, hardness));
  }

  return clamp01(fresnel * 0.7 + glare * (tuning.glareFactor / 100) * 0.35);
}

export function buildLiquidGlassField(
  surface: LiquidGlassSurface,
  tuning: LiquidGlassTuning,
): LiquidGlassField {
  const width = Math.max(1, Math.round(surface.width));
  const height = Math.max(1, Math.round(surface.height));
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const radius = Math.min(Math.max(surface.radius, 0), Math.min(halfWidth, halfHeight));
  const band = Math.max(
    1,
    tuning.refractionThickness * (height / REFERENCE_HEIGHT) + tuning.refractionDistance * height,
  );
  const maxDisplacement = Math.max(
    0.5,
    Math.min(band * 0.55, height * 0.08, Math.min(width, height) * 0.12),
  );
  const scale = maxDisplacement * 2;
  const rimWidth = Math.min(
    Math.max(1.5, tuning.fresnelRange * (height / REFERENCE_HEIGHT) * 0.5),
    Math.min(halfWidth, halfHeight),
  );
  const exponent = Math.max(1, tuning.refractionFactor);
  const pixels = new Uint8ClampedArray(width * height * 4);
  const gradientStep = 0.35;

  for (let y = 0; y < height; y += 1) {
    const offsetY = y + 0.5 - halfHeight;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const offsetX = x + 0.5 - halfWidth;
      const distance = -roundedRectDistance(offsetX, offsetY, halfWidth, halfHeight, radius);
      pixels[index] = 128;
      pixels[index + 1] = 128;
      pixels[index + 3] = 255;
      if (distance < 0) {
        continue;
      }

      if (distance < band) {
        const gradientX =
          roundedRectDistance(offsetX + gradientStep, offsetY, halfWidth, halfHeight, radius) -
          roundedRectDistance(offsetX - gradientStep, offsetY, halfWidth, halfHeight, radius);
        const gradientY =
          roundedRectDistance(offsetX, offsetY + gradientStep, halfWidth, halfHeight, radius) -
          roundedRectDistance(offsetX, offsetY - gradientStep, halfWidth, halfHeight, radius);
        const length = Math.hypot(gradientX, gradientY);
        if (length > 0) {
          const deformation = Math.pow(1 - distance / band, exponent);
          const magnitude = (deformation * maxDisplacement) / length;
          // Sampling inward keeps the refracting edge from reading transparent backdrop.
          pixels[index] = Math.round(clamp01(0.5 - (gradientX * magnitude) / scale) * 255);
          pixels[index + 1] = Math.round(clamp01(0.5 - (gradientY * magnitude) / scale) * 255);
        }
      }

      pixels[index + 2] = Math.round(
        specularAlpha(offsetX, offsetY, distance, height, tuning, rimWidth) * 255,
      );
    }
  }

  return { width, height, band, maxDisplacement, scale, pixels };
}

export interface LiquidGlassSample {
  /** Inward sample offset in units of `field.maxDisplacement`, so +1 is a full inward push. */
  offsetX: number;
  offsetY: number;
  specular: number;
}

export function readLiquidGlassField(
  field: LiquidGlassField,
  x: number,
  y: number,
): LiquidGlassSample {
  const index = (Math.round(y) * field.width + Math.round(x)) * 4;
  return {
    offsetX: (field.pixels[index]! / 255 - 0.5) * 2,
    offsetY: (field.pixels[index + 1]! / 255 - 0.5) * 2,
    specular: field.pixels[index + 2]! / 255,
  };
}
