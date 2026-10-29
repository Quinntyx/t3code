import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

// liquid-glass-studio's test card: stripes make bending and color split obvious, flat quadrants
// show the rim light on white and black. Fixed colors, so every theme previews the same backdrop.
const STRIPES = "#000 0 8px, #fff 8px 16px";
const quadrants = [
  { inset: "0 50% 50% 0", background: `repeating-linear-gradient(0deg, ${STRIPES})` },
  { inset: "0 0 50% 50%", background: "#fff" },
  { inset: "50% 50% 0 0", background: "#000" },
  { inset: "50% 0 0 50%", background: `repeating-linear-gradient(90deg, ${STRIPES})` },
] as const satisfies ReadonlyArray<CSSProperties>;

const glassClassName = "absolute -translate-x-1/2 shadow-lg surface-glass";

/** A miniature backdrop with glass on it, so liquid glass sliders show their effect while dragging. */
export function LiquidGlassPreview() {
  return (
    <div
      role="img"
      aria-label="Liquid glass preview over striped, white, and black backdrops"
      className="relative isolate mb-3 h-64 w-full max-w-md overflow-hidden rounded-xl border border-border"
    >
      {quadrants.map((style) => (
        <span key={style.inset} aria-hidden className="absolute" style={style} />
      ))}
      <span
        aria-hidden
        data-liquid-glass=""
        className={cn(glassClassName, "top-2.5 left-1/2 size-25 rounded-3xl")}
      />
      <span
        aria-hidden
        data-liquid-glass=""
        className={cn(glassClassName, "top-28.5 left-1/2 h-7 w-3/5 rounded-full")}
      />
      <span
        aria-hidden
        data-liquid-glass=""
        className={cn(glassClassName, "top-37.5 left-1/2 size-25 rounded-full")}
      />
    </div>
  );
}
