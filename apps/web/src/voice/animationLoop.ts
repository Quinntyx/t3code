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
  // Called without a receiver: a native frame function passed through another object throws
  // "Illegal invocation", so callers must hand in already-bound functions.
  const { request, cancel, paint } = scheduler;
  let frame: number | null = null;
  let active = false;
  let disposed = false;
  const tick = () => {
    frame = null;
    if (!active || disposed) return;
    paint(true);
    if (active && !disposed) frame = request(tick);
  };
  const stop = () => {
    if (frame !== null) cancel(frame);
    frame = null;
  };
  return {
    update(state: SpectrumActivity) {
      if (disposed) return;
      // The edge breathes for the whole connected session; audio only modulates it.
      active = state.connected && state.visible && state.open && !state.reducedMotion;
      if (active) {
        if (frame === null) frame = request(tick);
      } else {
        stop();
        paint(false);
      }
    },
    dispose() {
      disposed = true;
      active = false;
      stop();
    },
  };
}
