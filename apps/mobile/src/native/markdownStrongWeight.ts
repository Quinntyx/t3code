/**
 * Android only bolds fallback glyphs when the bold family is asked for at a bold weight
 * (app.config.ts bakes a bold weight into the bold family). iOS bolds the family by itself.
 */
export function strongFontWeight(
  boldByWeight: boolean | undefined,
  platform: string,
): "bold" | "normal" {
  return boldByWeight || platform === "android" ? "bold" : "normal";
}
