import { useEffect, useRef } from "react";

import { startAmbientShimmer } from "~/ambient-shimmer/renderer";
import { cn } from "~/lib/utils";

/** The experimental shimmer behind the chat column: full on the new thread page, faint in threads. */
export function AmbientShimmer({ prominent }: { prominent: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns a WebGL context and its animation loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const shimmer = startAmbientShimmer(container);
    return () => shimmer.stop();
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 transition-opacity duration-700 ease-out",
        prominent ? "opacity-100" : "opacity-30",
      )}
    />
  );
}
