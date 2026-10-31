import { useEffect, useRef } from "react";

import { useAmbientShimmerProminent } from "~/ambient-shimmer/prominence";
import { startAmbientShimmer } from "~/ambient-shimmer/renderer";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

/** The experimental shimmer behind the whole app: soft on new threads, fainter elsewhere. */
export function AmbientShimmer() {
  const enabled = useClientSettings((settings) => settings.ambientShimmerEnabled);
  return enabled ? <AmbientShimmerCanvas /> : null;
}

function AmbientShimmerCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const prominent = useAmbientShimmerProminent();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns a WebGL context and its animation loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const shimmer = startAmbientShimmer(container);
    return () => shimmer.stop();
  }, []);

  // The faded canvas needs the theme's canvas beneath it; the document itself stays white.
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 bg-background">
      <div
        ref={containerRef}
        className={cn(
          "absolute inset-0 transition-opacity duration-700 ease-out",
          prominent ? "opacity-30" : "opacity-12",
        )}
      />
    </div>
  );
}
