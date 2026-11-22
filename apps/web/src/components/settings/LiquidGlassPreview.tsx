/** Live preview of the liquid-glass shader over three contrasting backdrop zones. */
export function LiquidGlassPreview() {
  return (
    <div
      aria-hidden
      className="relative h-24 w-full overflow-hidden rounded-lg border border-border/70 select-none sm:h-20 sm:w-52"
    >
      <div className="grid h-full w-full grid-cols-[2fr_1fr]">
        <div
          className="h-full"
          style={{
            backgroundImage: "repeating-linear-gradient(135deg, #000 0 8px, #fff 8px 16px)",
          }}
        />
        <div className="grid h-full grid-rows-2">
          <div className="bg-white" />
          <div className="bg-black" />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-around px-3">
        <div
          className="h-11 w-11 rounded-full bg-card/(--glass-opacity) shadow-sm ring-1 ring-border/70 liquid-frost glass-glare"
          data-liquid-glass=""
        />
        <div
          className="h-11 w-11 rounded-xl bg-card/(--glass-opacity) shadow-sm ring-1 ring-border/70 liquid-frost glass-glare"
          data-liquid-glass=""
        />
        <div
          className="h-9 w-16 rounded-full bg-card/(--glass-opacity) shadow-sm ring-1 ring-border/70 liquid-frost glass-glare"
          data-liquid-glass=""
        />
      </div>
    </div>
  );
}
