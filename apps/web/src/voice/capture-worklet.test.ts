import { expect, it, vi } from "vite-plus/test";

it("runs the bundled capture processor with one outstanding frame credit and a terminal overflow", async () => {
  const postMessage = vi.fn();
  const port = { postMessage, onmessage: null as ((event: { data: string }) => void) | null };
  let Processor!: new () => { process: (inputs: Float32Array[][]) => boolean };
  vi.stubGlobal("sampleRate", 48000);
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      readonly port = port;
    },
  );
  vi.stubGlobal("registerProcessor", (_name: string, processor: typeof Processor) => {
    Processor = processor;
  });
  try {
    await import("./capture-worklet");
    const processor = new Processor();
    for (let block = 0; block < 8; block++)
      expect(processor.process([[new Float32Array(128)]])).toBe(true);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0]![0]).toEqual(new Uint8Array(640));
    port.onmessage!({ data: "ack" });
    for (let block = 0; block < 8; block++)
      expect(processor.process([[new Float32Array(128)]])).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(2);
    const results = Array.from({ length: 8 }, () => processor.process([[new Float32Array(128)]]));
    expect(results).toContain(false);
    expect(results.slice(results.indexOf(false)).every((result) => !result)).toBe(true);
    expect(postMessage.mock.calls.at(-1)![0]).toBe("overflow");
    port.onmessage!({ data: "stop" });
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
