import type { DeusVoiceConnection, DeusVoiceHandlers } from "@t3tools/client-runtime/state/deus";
import {
  acquireAudioSession,
  activateAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";

export interface NativeVoiceEvent {
  readonly id: number;
  readonly type: "pcm" | "route-change" | "interruption" | "background" | "error";
  readonly bytes?: Uint8Array;
  readonly message?: string;
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
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Voice failed. Connect again explicitly.";
let nextId = 0;

export class NativeVoiceAudio {
  private state = {
    id: 0,
    phase: "disconnected" as Phase,
    muted: false,
    error: null as string | null,
    cleanupRequired: false,
  };
  private readonly listeners = new Set<() => void>();
  private token: ReturnType<typeof acquireAudioSession> | null = null;
  private connection: DeusVoiceConnection | null = null;
  private attaching: Promise<DeusVoiceConnection> | null = null;
  private starting = false;
  private nativeStart: Promise<void> | null = null;
  private nativeOwned = false;
  private stopping: Promise<void> | null = null;
  private unwatch: (() => void) | null = null;
  private epoch = 0;
  private active = false;
  private controlBusy = false;
  constructor(private readonly device: NativeVoiceDevice) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
  async connect(attach: (handlers: DeusVoiceHandlers) => Promise<DeusVoiceConnection>) {
    if (this.starting || this.stopping || this.token || this.connection) return;
    this.starting = true;
    const id = ++nextId;
    this.state = { ...this.state, id };
    this.active = true;
    this.epoch = 0;
    this.update("connecting", null, false);
    try {
      if (!this.device.available)
        throw new Error(
          "Native duplex audio is unavailable in this binary. Text remains available.",
        );
      if (!(await this.device.requestPermission()))
        throw new Error(
          "Microphone permission denied. Enable it in system settings, then Connect again.",
        );
      if (!this.current(id)) return;
      const token = acquireAudioSession("duplex", () =>
        this.disconnect().then(() => {
          this.update("error", "Dictation took the microphone. Connect again explicitly.");
        }),
      );
      this.token = token;
      const owned = await activateAudioSession(token);
      if (!this.current(id)) return;
      if (!owned)
        throw new Error("Dictation owns the microphone. Finish dictation, then Connect again.");
      let inputBusy = false;
      this.unwatch = this.device.subscribe(async (event) => {
        if (!this.current(id) || event.id !== id) return;
        if (event.type !== "pcm") {
          await this.fail(
            new Error(event.message ?? `Voice stopped: ${event.type}. Connect again explicitly.`),
          );
          return;
        }
        if (!event.bytes || event.bytes.length !== 640 || inputBusy) {
          await this.fail(new Error("Native microphone exceeded its bounded PCM queue."));
          return;
        }
        inputBusy = true;
        try {
          if (
            !this.state.muted &&
            !this.controlBusy &&
            this.connection &&
            !(await this.connection.offer(event.bytes))
          )
            throw new Error("Microphone transport reached its bounded queue.");
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
              if (!bytes.length || bytes.length > 32000 || bytes.length % 2)
                throw new Error("Invalid native playback PCM.");
              this.device.play(id, bytes, epoch);
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
            if (event.type === "error") void this.fail(new Error(event.error.message));
            else if (event.type === "control") {
              if (event.state === "disconnected")
                void this.fail(new Error("Voice disconnected. Connect again explicitly."));
              else if (event.state === "listening" || event.state === "speaking")
                this.update(this.state.muted ? "muted" : event.state);
            } else if (event.type === "turn-end" && !this.state.muted) this.update("listening");
          },
          closed: () => {
            if (this.current(id))
              void this.fail(
                new Error("Voice lease or connection ended. Connect again explicitly."),
              );
          },
        }),
      );
      this.attaching = attaching;
      const connection = await attaching;
      this.connection = connection;
      if (!this.current(id)) return;
      this.update("listening");
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
  disconnect(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.active = false;
    this.controlBusy = false;
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
  }
}
