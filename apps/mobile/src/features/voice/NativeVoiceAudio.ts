import type {
  VoiceAudioConnection,
  VoiceAudioDevice,
  VoiceAudioHandlers,
} from "@t3tools/client-runtime/voice/client";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";

export interface NativeVoiceEvent {
  readonly id: number;
  readonly type: "pcm" | "route-change" | "interruption" | "background" | "error";
  readonly bytes?: Uint8Array | undefined;
  readonly message?: string | undefined;
}
export interface NativeVoiceDevice {
  readonly available: boolean;
  requestPermission(): Promise<boolean>;
  subscribe(listener: (event: NativeVoiceEvent) => Promise<void>): () => void;
  start(id: number): Promise<void>;
  stop(id: number): void;
  mute(id: number, muted: boolean): void;
  flush(id: number, epoch: number): void;
  play(id: number, bytes: Uint8Array, epoch: number): void;
  acknowledge(id: number): void;
}
type Phase = "disconnected" | "connecting" | "listening" | "speaking" | "muted" | "error";
export interface NativeVoiceState {
  readonly id: number;
  readonly phase: Phase;
  readonly muted: boolean;
  readonly error: string | null;
  readonly cleanupRequired: boolean;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Voice failed. Connect again explicitly.";
// The native modules accept at most this much PCM per call.
const MAX_PLAY_BYTES = 32_000;
const OUTPUT_BYTES_PER_SECOND = 24_000 * 2;

/** Loudness of PCM16 audio in 0..1, scaled so ordinary speech reaches the upper half. */
export function pcmLevel(bytes: Uint8Array) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, (Math.sqrt(sum / samples.length) / 32768) * 4);
}

let nextId = 0;

/** Owns the native duplex microphone and speaker for one Voice connection at a time. */
export class NativeVoiceAudio implements VoiceAudioDevice {
  private state: NativeVoiceState = {
    id: 0,
    phase: "disconnected",
    muted: false,
    error: null,
    cleanupRequired: false,
  };
  private readonly listeners = new Set<() => void>();
  private token: ReturnType<typeof acquireAudioSession> | null = null;
  private connection: VoiceAudioConnection | null = null;
  private attaching: Promise<VoiceAudioConnection> | null = null;
  private starting = false;
  private nativeStart: Promise<void> | null = null;
  private nativeOwned = false;
  private stopping: Promise<void> | null = null;
  private unwatch: (() => void) | null = null;
  private epoch = 0;
  private active = false;
  private controlBusy = false;
  private inputLevel = 0;
  private inputAt = 0;
  // Playback is estimated from what was queued, since the speaker reports no progress.
  private playback: Array<{ readonly end: number; readonly level: number }> = [];
  private speakingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly device: NativeVoiceDevice,
    private readonly now: () => number = Date.now,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** The loudness of whatever is audible now, for the panel's glow. */
  level = () => {
    if (!this.active || this.state.muted) return 0;
    const now = this.now();
    const input = now - this.inputAt < 120 ? this.inputLevel : 0;
    const output = this.playback.find((segment) => segment.end > now)?.level ?? 0;
    return Math.max(input, output);
  };
  private update(phase: Phase, error: string | null = null, muted = this.state.muted) {
    this.state = {
      ...this.state,
      phase,
      error,
      muted,
      cleanupRequired: phase === "error" && !!(this.token || this.connection),
    };
    for (const listener of this.listeners) listener();
  }
  private current(id: number) {
    return this.active && this.state.id === id;
  }
  private stopSpeaking() {
    this.playback = [];
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = null;
  }
  private play(id: number, bytes: Uint8Array, epoch: number) {
    if (!bytes.length || bytes.length % 2) throw new Error("Invalid playback PCM.");
    for (let offset = 0; offset < bytes.length; offset += MAX_PLAY_BYTES)
      this.device.play(id, bytes.subarray(offset, offset + MAX_PLAY_BYTES), epoch);
    const now = this.now();
    const start = Math.max(now, this.playback.at(-1)?.end ?? now);
    const end = start + (bytes.length / OUTPUT_BYTES_PER_SECOND) * 1000;
    this.playback = [
      ...this.playback.filter((segment) => segment.end > now),
      { end, level: pcmLevel(bytes) },
    ];
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = setTimeout(() => {
      this.speakingTimer = null;
      if (this.current(id) && this.state.phase === "speaking") this.update("listening");
    }, end - now);
    if (!this.state.muted && this.state.phase !== "speaking") this.update("speaking");
  }

  async connect(attach: (handlers: VoiceAudioHandlers) => Promise<VoiceAudioConnection>) {
    if (this.starting || this.stopping || this.token || this.connection) return;
    this.starting = true;
    const id = ++nextId;
    this.state = { ...this.state, id };
    this.active = true;
    this.epoch = 0;
    this.update("connecting", null, false);
    try {
      if (!this.device.available)
        throw new Error("Voice audio is unavailable in this build. Typing still works.");
      if (!(await this.device.requestPermission()))
        throw new Error(
          "Microphone permission denied. Allow it in system settings, then talk again.",
        );
      if (!this.current(id)) return;
      const token = acquireAudioSession("duplex", () =>
        this.disconnect().then(() => {
          this.update("error", "Dictation took the microphone. Talk again when it finishes.");
        }),
      );
      this.token = token;
      const owned = await activateAudioSession(token);
      if (!this.current(id)) return;
      if (!owned)
        throw new Error("Dictation is using the microphone. Finish dictating, then talk again.");
      let inputBusy = false;
      this.unwatch = this.device.subscribe(async (event) => {
        if (!this.current(id) || event.id !== id) return;
        if (event.type !== "pcm") {
          await this.fail(
            new Error(event.message ?? `Voice stopped: ${event.type}. Talk again to reconnect.`),
          );
          return;
        }
        if (!event.bytes || event.bytes.length !== 640 || inputBusy) {
          await this.fail(new Error("The microphone fell behind. Talk again to reconnect."));
          return;
        }
        inputBusy = true;
        try {
          this.inputLevel = pcmLevel(event.bytes);
          this.inputAt = this.now();
          if (
            !this.state.muted &&
            !this.controlBusy &&
            this.connection &&
            !(await this.connection.offer(event.bytes))
          )
            throw new Error("The microphone fell behind. Talk again to reconnect.");
          if (this.current(id)) this.device.acknowledge(id);
        } catch (error) {
          if (this.current(id)) await this.fail(error);
        } finally {
          inputBusy = false;
        }
      });
      this.nativeOwned = true;
      this.nativeStart = this.device.start(id);
      await this.nativeStart;
      if (!this.current(id) || !isAudioSessionOwner(token)) return;
      const attaching = Promise.resolve().then(() =>
        attach({
          audio: (bytes, epoch) => {
            if (!this.current(id) || epoch !== this.epoch) return;
            try {
              this.play(id, bytes, epoch);
            } catch (error) {
              void this.fail(error);
            }
          },
          epoch: (epoch) => {
            if (!this.current(id)) return;
            try {
              this.setEpoch(epoch);
            } catch (error) {
              void this.fail(error);
            }
          },
          event: (event) => {
            if (!this.current(id)) return;
            if (event.type === "error")
              void this.fail(new Error(event.error?.message ?? "Voice failed."));
            else if (event.type === "control") {
              if (event.state === "disconnected")
                void this.fail(new Error("Voice disconnected. Talk again to reconnect."));
              else if (event.state === "listening" || event.state === "speaking")
                this.update(this.state.muted ? "muted" : event.state);
            }
          },
          closed: () => {
            if (this.current(id))
              void this.fail(new Error("Voice connection ended. Talk again to reconnect."));
          },
        }),
      );
      this.attaching = attaching;
      const connection = await attaching;
      this.connection = connection;
      if (!this.current(id)) return;
      if (this.state.phase === "connecting") this.update("listening");
    } catch (error) {
      if (this.current(id)) await this.fail(error);
    } finally {
      this.attaching = null;
      this.nativeStart = null;
      this.starting = false;
    }
  }
  private setEpoch(epoch: number) {
    if (epoch <= this.epoch) return;
    this.epoch = epoch;
    this.device.flush(this.state.id, epoch);
    this.stopSpeaking();
    if (this.state.phase === "speaking") this.update("listening");
  }
  private async control(action: "mute" | "resume" | "interrupt-response") {
    if (!this.connection || this.controlBusy || !this.active) return;
    this.controlBusy = true;
    const id = this.state.id;
    try {
      if (action === "interrupt-response") this.setEpoch(this.epoch + 1);
      else {
        const muted = action === "mute";
        this.device.mute(id, muted);
        this.update(muted ? "muted" : "listening", null, muted);
      }
      if (!(await this.connection.control(action))) throw new Error(`Voice ${action} failed.`);
    } catch (error) {
      if (this.current(id)) await this.fail(error);
    } finally {
      if (this.current(id)) this.controlBusy = false;
    }
  }
  mute = () => this.control("mute");
  resume = () => this.control("resume");
  interrupt = () => this.control("interrupt-response");
  private async fail(error: unknown) {
    try {
      await this.disconnect();
    } catch (cleanup) {
      this.update("error", `${message(error)} Cleanup: ${message(cleanup)}`);
      return;
    }
    this.update("error", message(error), false);
  }
  disconnect = (): Promise<void> => {
    if (this.stopping) return this.stopping;
    this.active = false;
    this.controlBusy = false;
    this.stopSpeaking();
    this.unwatch?.();
    this.unwatch = null;
    const id = this.state.id;
    const token = this.token;
    const attachment = this.connection ? Promise.resolve(this.connection) : this.attaching;
    const nativeStart = this.nativeStart;
    this.stopping = Promise.allSettled([
      (async () => {
        await nativeStart?.catch(() => {});
        if (token) {
          if (this.nativeOwned) {
            this.device.stop(id);
            this.nativeOwned = false;
          }
          await releaseAudioSession(token);
          if (this.token === token) this.token = null;
        }
      })(),
      attachment?.then(
        async (connection) => {
          await connection.dispose();
          if (this.connection === connection) this.connection = null;
        },
        () => {},
      ),
    ])
      .then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          this.update("error", message(failed.reason), false);
          throw failed.reason;
        }
        this.update("disconnected", null, false);
      })
      .finally(() => {
        this.stopping = null;
      });
    return this.stopping;
  };
}
