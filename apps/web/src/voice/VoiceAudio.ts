import type {
  VoiceAudioConnection,
  VoiceAudioHandlers,
} from "@t3tools/client-runtime/voice/client";
import { decodePcm16 } from "./pcm";
import { hasAudio, quietSpectrum, type VoiceMeter } from "./spectrum";

export interface VoicePlatform {
  check: () => void;
  createContext: () => AudioContext;
  createMeter: (context: AudioContext) => VoiceMeter;
  getUserMedia: () => Promise<MediaStream>;
  createCapture: (
    context: AudioContext,
    stream: MediaStream,
    onInput: (bytes: Uint8Array) => Promise<boolean>,
    onError: (error: Error) => void,
    analyser: AudioNode,
  ) => Promise<{ stop: () => void }>;
  watchPermission?: (revoked: () => void) => Promise<() => void>;
}
type Phase = "disconnected" | "connecting" | "listening" | "speaking" | "muted" | "error";
export interface VoiceState {
  readonly phase: Phase;
  readonly error: string | null;
  readonly muted: boolean;
  readonly cleanupRequired: boolean;
  readonly flowing: boolean;
}
// Live streams a reply faster than it plays, so the queue holds a whole spoken reply.
const MAX_QUEUED_PLAYBACK_SECONDS = 120;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Voice failed. Connect again explicitly.";

export class VoiceAudio {
  private state: VoiceState = {
    phase: "disconnected",
    error: null,
    muted: false,
    cleanupRequired: false,
    flowing: false,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private epoch = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: { stop: () => void } | null = null;
  private connection: VoiceAudioConnection | null = null;
  private pendingAttachment: Promise<VoiceAudioConnection | null> | null = null;
  private unwatch: (() => void) | null = null;
  private inputMeter: VoiceMeter | null = null;
  private outputMeter: VoiceMeter | null = null;
  private inputFlowing = false;
  private readonly audibleSources = new Set<AudioBufferSourceNode>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextPlay = 0;
  private stopping: Promise<void> | null = null;
  private inputRevision = 0;
  private controlBusy = false;
  private starting = false;
  private pendingMedia = 0;

  constructor(private readonly platform: VoicePlatform) {}
  snapshot = () => this.state;
  getSpectrum = () => {
    if (!this.state.flowing || this.state.muted) return quietSpectrum;
    const input = this.inputMeter?.read() ?? quietSpectrum;
    const output = this.outputMeter?.read() ?? quietSpectrum;
    return output.energy >= input.energy ? output : input;
  };
  private publishFlow() {
    const flowing = !this.state.muted && (this.inputFlowing || this.audibleSources.size > 0);
    if (flowing === this.state.flowing) return;
    this.state = { ...this.state, flowing };
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(phase: Phase, error: string | null = null, muted = this.state.muted) {
    this.state = {
      phase,
      error,
      muted,
      cleanupRequired: phase === "error" && !!(this.context || this.connection),
      flowing:
        !muted &&
        phase !== "disconnected" &&
        phase !== "error" &&
        (this.inputFlowing || this.audibleSources.size > 0),
    };
    for (const listener of this.listeners) listener();
  }
  private readonly deviceEnded = () => {
    void this.fail(new Error("Microphone access ended. Connect again explicitly."));
  };
  private readonly contextChanged = () => {
    if (this.context && this.context.state !== "running")
      void this.fail(new Error("Audio playback was suspended. Connect again to resume audio."));
  };

  private async requestMicrophone() {
    this.pendingMedia++;
    try {
      return await this.platform.getUserMedia();
    } finally {
      this.pendingMedia--;
    }
  }

  async connect(attach: (handlers: VoiceAudioHandlers) => Promise<VoiceAudioConnection>) {
    if (
      this.starting ||
      this.stopping ||
      this.context ||
      this.connection ||
      this.state.phase === "connecting"
    )
      return;
    if (this.pendingMedia) {
      this.update(
        "error",
        "The previous microphone permission request is still pending. Dismiss it before reconnecting.",
      );
      return;
    }
    this.starting = true;
    const generation = ++this.generation;
    const active = () => generation === this.generation;
    this.epoch = 0;
    this.update("connecting", null, false);
    try {
      this.platform.check();
      const context = this.platform.createContext();
      this.context = context;
      this.inputMeter = this.platform.createMeter(context);
      this.outputMeter = this.platform.createMeter(context);
      this.outputMeter.node.connect(context.destination);
      // Both privileged operations begin in the Connect gesture, before any network await.
      const resumed = context.resume();
      const media = this.requestMicrophone().then((stream) => {
        if (!active()) {
          for (const track of stream.getTracks()) track.stop();
          return null;
        }
        this.stream = stream;
        return stream;
      });
      await Promise.all([resumed, media]);
      if (!active()) return;
      if (context.state !== "running")
        throw new Error("Autoplay blocked. Connect again to resume audio.");
      if (!this.stream) throw new Error("No microphone stream was acquired.");
      context.addEventListener("statechange", this.contextChanged);
      await this.startCapture(generation, this.stream);
      if (!active()) return;
      const attaching = attach({
        audio: (bytes, epoch) => {
          if (active()) this.play(bytes, epoch);
        },
        epoch: (epoch) => {
          if (active()) this.setEpoch(epoch);
        },
        event: (event) => {
          if (!active()) return;
          if (event.type === "error")
            void this.fail(new Error(event.error?.message ?? "The voice attachment failed."));
          else if (event.type === "turn-end") {
            if (!this.sources.size && !this.state.muted) this.update("listening");
          } else if (event.type === "control") {
            if (event.state === "disconnected")
              void this.fail(new Error("Voice disconnected. Connect again explicitly."));
            else if (event.state === "listening" || event.state === "speaking")
              this.update(this.state.muted ? "muted" : event.state);
          }
        },
        closed: () => {
          if (active())
            void this.fail(new Error("Voice connection ended. Connect again explicitly."));
        },
      });
      this.pendingAttachment = attaching.then(
        (connection) => {
          this.connection = connection;
          return connection;
        },
        () => null,
      );
      await this.pendingAttachment;
      await attaching;
      if (!active()) return;
      if (this.platform.watchPermission) {
        const unwatch = await this.platform.watchPermission(this.deviceEnded);
        if (!active()) unwatch();
        else this.unwatch = unwatch;
      }
    } catch (error) {
      if (active()) await this.fail(error);
    } finally {
      this.pendingAttachment = null;
      this.starting = false;
    }
  }

  private async startCapture(generation: number, stream: MediaStream) {
    for (const track of stream.getTracks()) track.addEventListener("ended", this.deviceEnded);
    const revision = ++this.inputRevision;
    const capture = await this.platform.createCapture(
      this.context!,
      stream,
      async (bytes) => {
        if (generation !== this.generation || revision !== this.inputRevision) return false;
        if (this.state.muted || !this.connection || this.controlBusy) return true;
        try {
          this.inputFlowing = hasAudio(decodePcm16(bytes));
          this.publishFlow();
          const accepted = await this.connection.offer(bytes);
          if (!accepted && generation === this.generation && revision === this.inputRevision)
            void this.fail(
              new Error(
                "Microphone transport reached its bounded queue. Connect again explicitly.",
              ),
            );
          return accepted;
        } catch (error) {
          if (generation === this.generation) void this.fail(error);
          return false;
        }
      },
      (error) => {
        if (generation === this.generation && revision === this.inputRevision)
          void this.fail(error);
      },
      this.inputMeter!.node,
    );
    if (generation !== this.generation || revision !== this.inputRevision) capture.stop();
    else this.capture = capture;
  }

  private stopInput() {
    this.inputRevision++;
    this.capture?.stop();
    this.capture = null;
    this.inputFlowing = false;
    this.publishFlow();
    if (this.stream)
      for (const track of this.stream.getTracks()) {
        track.removeEventListener("ended", this.deviceEnded);
        track.stop();
      }
    this.stream = null;
  }
  private flush() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* A source whose start failed is already silent. */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.audibleSources.clear();
    this.publishFlow();
    this.nextPlay = 0;
  }
  private setEpoch(epoch: number) {
    if (epoch <= this.epoch) return;
    this.epoch = epoch;
    this.flush();
    if (this.state.phase === "speaking") this.update("listening");
  }
  private play(bytes: Uint8Array, epoch: number) {
    if (epoch !== this.epoch || !this.context) return;
    try {
      const context = this.context;
      const samples = decodePcm16(bytes);
      const start = Math.max(context.currentTime, this.nextPlay);
      const end = start + samples.length / 24000;
      if (end - context.currentTime > MAX_QUEUED_PLAYBACK_SECONDS)
        throw new Error("Voice playback fell too far behind. Connect again explicitly.");
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputMeter!.node);
      this.sources.add(source);
      if (hasAudio(samples)) this.audibleSources.add(source);
      this.publishFlow();
      const generation = this.generation;
      source.onended = () => {
        if (generation !== this.generation || epoch !== this.epoch) return;
        this.sources.delete(source);
        this.audibleSources.delete(source);
        this.publishFlow();
        source.disconnect();
        if (!this.sources.size && !this.state.muted) this.update("listening");
      };
      source.start(start);
      this.nextPlay = end;
      if (!this.state.muted) this.update("speaking");
    } catch (error) {
      void this.fail(error);
    }
  }

  async interrupt() {
    if (!this.connection || this.controlBusy) return;
    this.controlBusy = true;
    const generation = this.generation;
    this.setEpoch(this.epoch + 1);
    try {
      if (!(await this.connection.control("interrupt-response")))
        throw new Error("Voice interruption failed.");
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    } finally {
      if (generation === this.generation) this.controlBusy = false;
    }
  }
  async mute() {
    if (!this.connection || this.controlBusy || this.state.muted) return;
    this.controlBusy = true;
    const generation = this.generation;
    this.stopInput();
    this.update("muted", null, true);
    try {
      if (!(await this.connection.control("mute"))) throw new Error("Microphone mute failed.");
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    } finally {
      if (generation === this.generation) this.controlBusy = false;
    }
  }
  async resume() {
    if (!this.connection || this.controlBusy || !this.state.muted) return;
    this.controlBusy = true;
    const generation = this.generation;
    try {
      const stream = await this.requestMicrophone();
      if (generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      await this.startCapture(generation, stream);
      if (generation !== this.generation) return;
      if (!(await this.connection!.control("resume"))) throw new Error("Microphone resume failed.");
      if (generation === this.generation)
        this.update(this.sources.size ? "speaking" : "listening", null, false);
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    } finally {
      if (generation === this.generation) this.controlBusy = false;
    }
  }
  private async fail(error: unknown) {
    try {
      await this.disconnect();
    } catch (cleanup) {
      this.update("error", `${errorMessage(error)} Cleanup: ${errorMessage(cleanup)}`);
      return;
    }
    this.update("error", errorMessage(error), false);
  }
  disconnect(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.generation++;
    this.controlBusy = false;
    this.stopInput();
    this.flush();
    this.inputMeter?.dispose();
    this.outputMeter?.dispose();
    this.inputMeter = this.outputMeter = null;
    this.unwatch?.();
    this.unwatch = null;
    this.context?.removeEventListener("statechange", this.contextChanged);
    const context = this.context;
    const connection = this.connection;
    const attachment = connection ? Promise.resolve(connection) : this.pendingAttachment;
    this.stopping = Promise.allSettled([
      context?.close().then(() => {
        if (this.context === context) this.context = null;
      }),
      attachment?.then(async (owned) => {
        if (!owned) return;
        await owned.dispose();
        if (this.connection === owned) this.connection = null;
      }),
    ])
      .then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          this.update("error", errorMessage(failure.reason), false);
          throw failure.reason;
        }
        this.update("disconnected", null, false);
      })
      .finally(() => {
        this.stopping = null;
      });
    return this.stopping;
  }
}
