export interface SpectrumFrame {
  readonly energy: number;
  readonly bands: readonly number[];
  readonly bins: readonly number[];
  readonly flux: number;
}
export const quietSpectrum: SpectrumFrame = {
  energy: 0,
  bands: [0, 0, 0, 0, 0],
  bins: [],
  flux: 0,
};
export interface VoiceMeter {
  readonly node: AudioNode;
  readonly read: () => SpectrumFrame;
  readonly dispose: () => void;
}

export function hasAudio(samples: Float32Array) {
  return (
    samples.length > 0 &&
    samples.reduce((sum, value) => sum + value * value, 0) / samples.length > 0.004 ** 2
  );
}

// Adapted from Pearl's measured analyser; the noise floor affects visuals, never capture.
export class AudioMeter implements VoiceMeter {
  readonly node: AnalyserNode;
  private readonly frequency: Uint8Array<ArrayBuffer>;
  private readonly waveform: Float32Array<ArrayBuffer>;
  private previous = 0;
  constructor(context: AudioContext) {
    this.node = context.createAnalyser();
    this.node.fftSize = 512;
    this.node.smoothingTimeConstant = 0.55;
    this.frequency = new Uint8Array(this.node.frequencyBinCount);
    this.waveform = new Float32Array(this.node.fftSize);
  }
  read(): SpectrumFrame {
    this.node.getByteFrequencyData(this.frequency);
    this.node.getFloatTimeDomainData(this.waveform);
    const rms = Math.sqrt(
      this.waveform.reduce((sum, value) => sum + value * value, 0) / this.waveform.length,
    );
    const energy = Math.min(1, Math.max(0, (rms - 0.004) * 8));
    const edges = [0, 4, 12, 32, 80, this.frequency.length];
    const bins = Array.from(this.frequency, (value) => value / 255);
    const bands = edges.slice(0, -1).map((from, index) => {
      let sum = 0;
      for (let bin = from; bin < edges[index + 1]!; bin++) sum += bins[bin]!;
      return (energy * sum) / (edges[index + 1]! - from);
    });
    const flux = energy - this.previous;
    this.previous = energy;
    return { energy, bands, bins, flux };
  }
  dispose() {
    this.node.disconnect();
  }
}
