import { Pcm16Capture } from "./pcm";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private readonly pcm = new Pcm16Capture(sampleRate);
  private credit = true;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "ack") this.credit = true;
      if (event.data === "stop") this.stopped = true;
    };
  }

  process(inputs: Float32Array[][]) {
    if (this.stopped) return false;
    const mono = inputs[0]?.[0];
    if (!mono) return true;
    try {
      for (const bytes of this.pcm.push(mono)) {
        if (!this.credit) throw new Error("Capture worklet backpressure.");
        this.credit = false;
        this.port.postMessage(bytes, [bytes.buffer]);
      }
      return true;
    } catch {
      this.stopped = true;
      this.port.postMessage("overflow", []);
      return false;
    }
  }
}
registerProcessor("voice-capture", VoiceCaptureProcessor);
