const MAX_BLOCK = 4096;

export class Pcm16Capture {
  private previous = 0;
  private index = -1;
  private next = 0;
  private offset = 0;
  private frame: Uint8Array;
  private readonly step: number;

  constructor(
    rate: number,
    private readonly samplesPerFrame = 320,
  ) {
    if (
      !Number.isFinite(rate) ||
      rate < 8000 ||
      rate > 192000 ||
      !Number.isInteger(samplesPerFrame) ||
      samplesPerFrame < 1 ||
      samplesPerFrame > 16000
    ) {
      throw new Error("Unsupported capture rate or PCM frame size.");
    }
    this.step = rate / 16000;
    this.frame = new Uint8Array(samplesPerFrame * 2);
  }

  push(input: Float32Array): Uint8Array[] {
    if (input.length > MAX_BLOCK) throw new Error("Capture block exceeds the audio bound.");
    const frames: Uint8Array[] = [];
    for (const raw of input) {
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      this.index++;
      while (this.next <= this.index) {
        const sample =
          this.index === 0
            ? value
            : this.previous + (value - this.previous) * (this.next - this.index + 1);
        const pcm = Math.max(
          -32768,
          Math.min(32767, Math.round(sample * (sample < 0 ? 32768 : 32767))),
        );
        this.frame[this.offset++] = pcm & 255;
        this.frame[this.offset++] = (pcm >> 8) & 255;
        this.next += this.step;
        if (this.offset === this.frame.length) {
          frames.push(this.frame);
          this.frame = new Uint8Array(this.samplesPerFrame * 2);
          this.offset = 0;
        }
      }
      this.previous = value;
    }
    return frames;
  }
}

export function decodePcm16(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  if (!bytes.length || bytes.length > 32000 || bytes.length % 2 !== 0)
    throw new Error("Invalid PCM16LE output frame.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from(
    { length: bytes.length / 2 },
    (_, index) => view.getInt16(index * 2, true) / 32768,
  );
}
