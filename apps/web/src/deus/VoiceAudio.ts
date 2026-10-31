import { decodePcm16 } from "./pcm";

export interface VoiceConnection {
  readonly offer: (bytes: Uint8Array) => Promise<boolean>;
  readonly control: (action: "mute" | "resume" | "interrupt-response") => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}
export interface VoiceHandlers {
  readonly audio: (bytes: Uint8Array, epoch: number) => void;
  readonly epoch: (epoch: number) => void;
  readonly event: (event: {
    readonly type: string;
    readonly state?: string;
    readonly error?: { readonly message: string };
  }) => void;
  readonly closed: () => void;
}
export interface VoicePlatform {
  check: () => void;
  createContext: () => AudioContext;
  getUserMedia: () => Promise<MediaStream>;
  createCapture: (
    context: AudioContext,
    stream: MediaStream,
    onInput: (bytes: Uint8Array) => Promise<boolean>,
    onError: (error: Error) => void,
  ) => Promise<{ stop: () => void }>;
  watchPermission?: (revoked: () => void) => Promise<() => void>;
}
type Phase = "disconnected" | "connecting" | "listening" | "speaking" | "muted" | "error";
export interface VoiceState {
  readonly phase: Phase;
  readonly error: string | null;
  readonly muted: boolean;
  readonly cleanupRequired: boolean;
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Voice failed. Connect again explicitly.";

export class VoiceAudio {
  private state: VoiceState = {
    phase: "disconnected",
    error: null,
    muted: false,
    cleanupRequired: false,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private epoch = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: { stop: () => void } | null = null;
  private connection: VoiceConnection | null = null;
  private pendingAttachment: Promise<VoiceConnection | null> | null = null;
  private unwatch: (() => void) | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextPlay = 0;
  private stopping: Promise<void> | null = null;
  private inputRevision = 0;
  private controlBusy = false;
  private starting = false;
  private pendingMedia = 0;

  constructor(private readonly platform: VoicePlatform) {}
  snapshot = () => this.state;
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

  async connect(attach: (handlers: VoiceHandlers) => Promise<VoiceConnection>) {
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
            void this.fail(new Error("Voice lease or connection ended. Connect again explicitly."));
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
    );
    if (generation !== this.generation || revision !== this.inputRevision) capture.stop();
    else this.capture = capture;
  }

  private stopInput() {
    this.inputRevision++;
    this.capture?.stop();
    this.capture = null;
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
      if (this.sources.size >= 32 || end - context.currentTime > 1)
        throw new Error("Voice playback exceeded its one-second queue. Connect again explicitly.");
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.sources.add(source);
      const generation = this.generation;
      source.onended = () => {
        if (generation !== this.generation || epoch !== this.epoch) return;
        this.sources.delete(source);
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
