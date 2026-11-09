export interface SpectrumActivity {
  readonly connected: boolean;
  readonly flowing: boolean;
  readonly muted: boolean;
  readonly visible: boolean;
  readonly open: boolean;
  readonly reducedMotion: boolean;
}

export function createSpectrumLoop(scheduler: {
  readonly request: (callback: () => void) => number;
  readonly cancel: (frame: number) => void;
  readonly paint: (active: boolean) => void;
}) {
  let frame: number | null = null;
  let active = false;
  let disposed = false;
  const tick = () => {
    frame = null;
    if (!active || disposed) return;
    scheduler.paint(true);
    if (active && !disposed) frame = scheduler.request(tick);
  };
  const stop = () => {
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
  };
  return {
    update(state: SpectrumActivity) {
      if (disposed) return;
      // The edge breathes for the whole connected session; audio only modulates it.
      active = state.connected && state.visible && state.open && !state.reducedMotion;
      if (active) {
        if (frame === null) frame = scheduler.request(tick);
      } else {
        stop();
        scheduler.paint(false);
      }
    },
    dispose() {
      disposed = true;
      active = false;
      stop();
    },
  };
}
