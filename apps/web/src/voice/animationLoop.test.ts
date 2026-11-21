import { expect, it } from "vite-plus/test";
import { createSpectrumLoop } from "./animationLoop";

it("animates while the open panel is connected, even through silence, and cancels every pending frame", () => {
  let next = 0;
  const frames = new Map<number, () => void>();
  const painted: boolean[] = [];
  const loop = createSpectrumLoop({
    request: (callback) => {
      frames.set(++next, callback);
      return next;
    },
    cancel: (id) => {
      frames.delete(id);
    },
    paint: (active) => {
      painted.push(active);
    },
  });
  const active = {
    connected: true,
    flowing: true,
    muted: false,
    visible: true,
    open: true,
    reducedMotion: false,
  };
  loop.update({ ...active, connected: false });
  expect(frames.size).toBe(0);
  expect(painted).toEqual([false]);
  loop.update({ ...active, flowing: false, muted: true });
  expect(frames.size).toBe(1);
  const frame = frames.values().next().value!;
  frames.clear();
  frame();
  expect(painted.at(-1)).toBe(true);
  expect(frames.size).toBe(1);
  for (const patch of [
    { connected: false },
    { visible: false },
    { open: false },
    { reducedMotion: true },
  ]) {
    loop.update(active);
    expect(frames.size).toBe(1);
    loop.update({ ...active, ...patch });
    expect(frames.size).toBe(0);
    expect(painted.at(-1)).toBe(false);
  }
  loop.update(active);
  loop.dispose();
  expect(frames.size).toBe(0);
  loop.update(active);
  expect(frames.size).toBe(0);
});
