import { useEffect, useRef, useState } from "react";
import { observeResize } from "../lib/observeResize";
import { voiceAudio } from "./controller";
import { createSpectrumLoop } from "./animationLoop";
import { createSpectralRenderer } from "./spectralRenderer";

export function SpectralEdge({
  open,
  connected,
}: {
  readonly open: boolean;
  readonly connected: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns GPU resources and external audio, visibility, resize and motion subscriptions
  useEffect(() => {
    const element = canvas.current;
    if (!element || !open) return;
    const renderer = createSpectralRenderer(element, voiceAudio.getSpectrum);
    setAvailable(renderer !== null);
    if (!renderer) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let failed = false;
    const loop = createSpectrumLoop({
      request: (callback) => requestAnimationFrame(callback),
      cancel: cancelAnimationFrame,
      paint: (active) => {
        if (failed || document.hidden) return;
        try {
          renderer.paint(active);
        } catch {
          failed = true;
          loop.dispose();
          renderer.dispose();
          setAvailable(false);
        }
      },
    });
    const update = () => {
      if (failed) return;
      const audio = voiceAudio.snapshot();
      loop.update({
        connected,
        flowing: audio.flowing,
        muted: audio.muted,
        visible: !document.hidden,
        open,
        reducedMotion: motion.matches,
      });
    };
    const repaint = () => {
      renderer.updateBackground();
      update();
    };
    const lost = (event: Event) => {
      event.preventDefault();
      failed = true;
      loop.dispose();
      renderer.dispose();
      setAvailable(false);
    };
    element.addEventListener("webglcontextlost", lost);
    document.addEventListener("visibilitychange", update);
    motion.addEventListener("change", update);
    const stopAudio = voiceAudio.subscribe(update);
    const stopResize = observeResize(element, repaint);
    const theme = new MutationObserver(repaint);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    repaint();
    return () => {
      loop.dispose();
      stopAudio();
      stopResize();
      theme.disconnect();
      document.removeEventListener("visibilitychange", update);
      motion.removeEventListener("change", update);
      element.removeEventListener("webglcontextlost", lost);
      renderer.dispose();
    };
  }, [open, connected]);
  return (
    <canvas
      ref={canvas}
      data-voice-spectrum
      className="pointer-events-none absolute inset-0 -z-1 size-full [mask-image:linear-gradient(to_bottom,transparent,black_55%)] data-[available=false]:invisible"
      data-available={available && open}
      aria-hidden="true"
    />
  );
}
