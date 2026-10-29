import { useEffect, useRef } from "react";

import { startAmbientShimmer, type AmbientShimmer as Shimmer } from "~/ambient-shimmer/renderer";

/** The experimental shimmer behind the chat column; it drifts slower behind a conversation. */
export function AmbientShimmer({ calm }: { calm: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shimmerRef = useRef<Shimmer | null>(null);
  const calmRef = useRef(calm);

  // Declared first so the mount below starts at the current pace instead of easing into it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- eases the running animation loop's pace
  useEffect(() => {
    calmRef.current = calm;
    shimmerRef.current?.setCalm(calm);
  }, [calm]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns a WebGL context and its animation loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const shimmer = startAmbientShimmer(container, calmRef.current);
    shimmerRef.current = shimmer;
    return () => {
      shimmer.stop();
      shimmerRef.current = null;
    };
  }, []);

  return <div ref={containerRef} aria-hidden className="pointer-events-none absolute inset-0" />;
}
