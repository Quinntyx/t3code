// @effect-diagnostics globalTimers:off globalFetch:off - This browser and WebView transport runs without an Effect runtime.
import { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";
import {
  decodePreviewStreamFrame,
  PREVIEW_STREAM_AUDIO_CHANNELS,
  PREVIEW_STREAM_AUDIO_FRAME_TAG,
  PREVIEW_STREAM_AUDIO_CODECS,
  PREVIEW_STREAM_AUDIO_SAMPLE_RATE,
  PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE,
  PREVIEW_STREAM_VIDEO_CODECS,
  type PreviewStreamAudioFrame,
  type PreviewStreamHostSetup,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const PREVIEW_STREAM_BASE_PATH = "/api/preview-stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

export type PreviewStreamPhase = "connecting" | "awaiting-frame" | "live" | "reconnecting";

export const previewStreamPhase = (
  control: PreviewStreamControl | null,
  hasCurrentFrame: boolean,
  hasRetainedFrame = hasCurrentFrame,
): PreviewStreamPhase =>
  hasCurrentFrame
    ? control !== null
      ? "live"
      : "reconnecting"
    : hasRetainedFrame
      ? "reconnecting"
      : control !== null
        ? "awaiting-frame"
        : "connecting";

const previewStreamControlLabel = (
  control: PreviewStreamControl,
  resolve: MFunctionType = mFallback,
): string =>
  !control.canOperate
    ? resolve(msg("Read-only"))
    : control.controller === "you"
      ? resolve(msg("You have control"))
      : control.controller === "agent"
        ? resolve(msg("Agent has control"))
        : control.controller === "another-viewer"
          ? resolve(msg("Another viewer has control"))
          : resolve(
              msg("Watching", { $context: "preview stream status, viewing without control" }),
            );

export const previewStreamStatusLabel = (
  phase: PreviewStreamPhase,
  control: PreviewStreamControl | null,
  resolve: MFunctionType = mFallback,
): string => {
  switch (phase) {
    case "connecting":
      return resolve(msg("Connecting to remote stream…"));
    case "awaiting-frame":
      return control
        ? resolve(
            msg("Waiting for video frame · {control}", {
              control: previewStreamControlLabel(control, resolve),
            }),
          )
        : resolve(msg("Waiting for video frame…"));
    case "reconnecting":
      return control
        ? resolve(
            msg("Reconnecting stream · {control}", {
              control: previewStreamControlLabel(control, resolve),
            }),
          )
        : resolve(msg("Reconnecting stream…"));
    case "live":
      return control
        ? previewStreamControlLabel(control, resolve)
        : resolve(msg("Connecting to remote stream…"));
  }
};

export const previewStreamOverlayDetail = (
  phase: PreviewStreamPhase,
  environmentLabel?: string,
  resolve: MFunctionType = mFallback,
): string => {
  switch (phase) {
    case "awaiting-frame":
      return resolve(msg("Waiting for first frame…"));
    case "reconnecting":
      return resolve(msg("Reconnecting to remote browser…"));
    case "connecting":
    case "live": {
      const label = environmentLabel?.trim();
      return label
        ? resolve(msg("Starting video stream from {environment}…", { environment: label }))
        : resolve(msg("Starting video stream…"));
    }
  }
};

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Coordinates are page CSS px. */
export type PreviewStreamInput =
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  | { readonly type: "stopLoading" }
  | { readonly type: "probe"; readonly x: number; readonly y: number };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  readonly accept: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  chooser: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/upload?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      chooser,
    }).toString()}`,
    target.access,
  );

export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

export const previewStreamDownloadUrl = (
  target: Pick<PreviewStreamTarget, "access" | "threadId" | "tabId">,
  id: string,
): string =>
  withDeviceHubQuery(
    `${target.access.httpBase}/download?${new URLSearchParams({
      threadId: target.threadId,
      tabId: target.tabId,
      id,
    }).toString()}`,
    target.access,
  );

export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: DeviceHubAccess;
  readonly threadId: string;
  readonly tabId: string;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
  /**
   * Never ask for audio, even with a decoder. A permanently silent surface would otherwise
   * make the server capture and encode packets it discards.
   */
  readonly audio?: boolean;
}

export interface PreviewStreamEvents {
  /** A JPEG or video frame; pass it to a `PreviewFramePainter`. */
  readonly onFrame: (frame: ArrayBuffer) => void;
  /** One audio packet for `PreviewAudioPlayer.push`. */
  readonly onAudio?: (frame: PreviewStreamAudioFrame) => void;
  /** Whether this tab can play sound at all; false means a mute control would do nothing. */
  readonly onAudioAvailable?: (available: boolean) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  readonly onPopup?: (tabId: string) => void;
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  readonly onGone?: () => void;
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
}

export interface PreviewStreamClient {
  readonly send: (input: PreviewStreamInput) => boolean;
  /** For a painter whose video decoder failed; the next video frame is then a key frame. */
  readonly requestKeyFrame: () => void;
  readonly stop: () => void;
}

let decodableVideoCodecs: Promise<ReadonlyArray<string>> | null = null;
const videoCodecs = () =>
  (decodableVideoCodecs ??= Promise.all(
    PREVIEW_STREAM_VIDEO_CODECS.map((codec) =>
      VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true }).then(
        (support) => (support.supported ? [codec] : []),
        () => [],
      ),
    ),
  ).then((supported) => supported.flat()));

let decodableAudioCodecs: Promise<ReadonlyArray<string>> | null = null;
const audioCodecs = () =>
  (decodableAudioCodecs ??= Promise.all(
    PREVIEW_STREAM_AUDIO_CODECS.map((codec) =>
      AudioDecoder.isConfigSupported({
        codec,
        sampleRate: PREVIEW_STREAM_AUDIO_SAMPLE_RATE,
        numberOfChannels: PREVIEW_STREAM_AUDIO_CHANNELS,
      }).then(
        (support) => (support.supported ? [codec] : []),
        () => [],
      ),
    ),
  ).then((supported) => supported.flat()));

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
const KEY_FRAME_MESSAGE = JSON.stringify({ type: "keyFrame" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  const query = new URLSearchParams({
    threadId: target.threadId,
    tabId: target.tabId,
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.interactive === false) query.set("interactive", "false");
  const wantsAudio = target.audio !== false;
  let url = "";
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;

  // The server re-offers a picker still open, under a new id, when this viewer reattaches.
  const withdrawFileChooser = () => {
    if (fileChooser === null) return;
    fileChooser = null;
    events.onFileChooser?.(null);
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        // Audio and video share the binary channel; only the tag tells them apart. Only a
        // frame is acked, since the server's ack queue matches its frame queue.
        if (new Uint8Array(event.data)[0] === PREVIEW_STREAM_AUDIO_FRAME_TAG) {
          const frame = decodePreviewStreamFrame(new Uint8Array(event.data));
          // An audio message too short to carry its header is skipped, not played.
          if (frame?.type === "audio") events.onAudio?.(frame);
          return;
        }
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
        available,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "audio" && typeof available === "boolean") {
        events.onAudioAvailable?.(available);
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
        };
        control = nextControl;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      withdrawFileChooser();
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  const open = (codecs: ReadonlyArray<string>, audio: boolean) => {
    if (codecs.length > 0) query.set("codecs", codecs.join(","));
    if (audio) query.set("audio", PREVIEW_STREAM_AUDIO_CODECS.join(","));
    url = withDeviceHubQuery(`${target.access.wsBase}/ws?${query.toString()}`, target.access);
    connect();
  };
  // WebCodecs is missing in insecure contexts and older WebViews, which keep JPEG frames and
  // never ask for audio. A viewer that would play audio reports that itself: the server only
  // tells viewers that asked for audio whether it is available.
  const playsAudio = wantsAudio && events.onAudio !== undefined;
  const openWith = (codecs: ReadonlyArray<string>, audio: ReadonlyArray<string>) => {
    if (playsAudio && audio.length === 0) events.onAudioAvailable?.(false);
    open(codecs, audio.length > 0);
  };
  if (typeof VideoDecoder === "undefined") openWith([], []);
  else
    void Promise.all([
      videoCodecs(),
      playsAudio && typeof AudioDecoder !== "undefined" ? audioCodecs() : [],
    ]).then(([codecs, audio]) => openWith(codecs, audio));

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (input.type !== "takeControl" && control.controller !== "you") return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    requestKeyFrame: () => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(KEY_FRAME_MESSAGE);
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      withdrawFileChooser();
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (frame: ArrayBuffer) => void;
  readonly reset: () => void;
  readonly stop: () => void;
}

/**
 * Paints JPEG and video frames, never letting an older frame cover a newer one. JPEGs decode
 * one at a time and keep only the latest waiting; every video frame decodes, as each builds on
 * the last. A failed decoder waits for the key frame `onKeyFrameNeeded` asks for.
 */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
  onKeyFrameNeeded?: () => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let generation = 0;
  let sequence = 0;
  let painted = -1;
  let decoding = false;
  let waiting: {
    readonly generation: number;
    readonly order: number;
    readonly jpeg: Uint8Array;
  } | null = null;
  let decoder: VideoDecoder | null = null;
  const closeDecoder = () => {
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
  };
  const show = (
    frameGeneration: number,
    order: number,
    image: CanvasImageSource,
    width: number,
    height: number,
  ) => {
    if (stopped || !context || frameGeneration !== generation || order < painted) return;
    painted = order;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(image, 0, 0);
    onPainted?.();
  };
  const drawJpeg = (frameGeneration: number, order: number, jpeg: Uint8Array) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
      .then((bitmap) => {
        show(frameGeneration, order, bitmap, bitmap.width, bitmap.height);
        bitmap.close();
      })
      .catch(() => undefined)
      .finally(() => {
        if (frameGeneration !== generation) return;
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped && next.generation === generation) {
          drawJpeg(next.generation, next.order, next.jpeg);
        }
      });
  };
  const openDecoder = (decoderGeneration: number) =>
    new VideoDecoder({
      output: (frame) => {
        show(decoderGeneration, frame.timestamp, frame, frame.displayWidth, frame.displayHeight);
        frame.close();
      },
      error: () => {
        if (decoderGeneration !== generation) return;
        resetDecoder();
      },
    });
  const resetDecoder = () => {
    closeDecoder();
    if (!stopped) onKeyFrameNeeded?.();
  };
  const reset = () => {
    generation += 1;
    decoding = false;
    waiting = null;
    closeDecoder();
  };
  return {
    paint: (data) => {
      const frame = decodePreviewStreamFrame(new Uint8Array(data));
      // Audio reaches the player through `onAudio`; a painter only sees video.
      if (stopped || !frame || frame.type === "audio") return;
      const frameGeneration = generation;
      const order = sequence++;
      if (frame.type === "jpeg") {
        if (decoding) waiting = { generation: frameGeneration, order, jpeg: frame.data };
        else drawJpeg(frameGeneration, order, frame.data);
        return;
      }
      try {
        if (frame.type === "key") {
          decoder ??= openDecoder(frameGeneration);
          decoder.configure({
            codec: frame.codec,
            codedWidth: frame.width,
            codedHeight: frame.height,
            optimizeForLatency: true,
          });
        }
        // Deltas are useless until the key frame after a decoder failure or reset.
        if (!decoder) return;
        decoder.decode(
          new EncodedVideoChunk({ type: frame.type, timestamp: order, data: frame.data }),
        );
      } catch {
        resetDecoder();
      }
    },
    reset,
    stop: () => {
      stopped = true;
      reset();
    },
  };
}

export interface PreviewAudioPlayer {
  /** One packet from the stream, already stripped of its frame header. */
  readonly push: (frame: PreviewStreamAudioFrame) => void;
  readonly setMuted: (muted: boolean) => void;
  /** Browsers start audio suspended until a gesture; call this from one. */
  readonly resume: () => void;
  readonly stop: () => void;
}

/**
 * How far ahead of the audio clock a packet may be scheduled, which absorbs jitter without
 * adding a noticeable delay. A packet whose moment has passed is dropped rather than played
 * late: the page already played it, and playing it late would drag everything after it.
 */
const AUDIO_START_DELAY_SECONDS = 0.06;
const AUDIO_MAX_LEAD_SECONDS = 0.25;

/**
 * Plays the stream's Opus packets through Web Audio, scheduled from each packet's source
 * timestamp so the page's own pauses stay pauses. A packet that can no longer be placed is
 * dropped, and a generation change resets decoder, clock and scheduled audio together. Mute is
 * one gain on this output, so it never resets the run.
 */
export function createPreviewAudioPlayer(options?: {
  readonly onBlocked?: () => void;
}): PreviewAudioPlayer {
  let context: AudioContext | null = null;
  /** Everything the player schedules rides this gain, so mute never touches the run itself. */
  let output: GainNode | null = null;
  let decoder: AudioDecoder | null = null;
  let muted = false;
  let stopped = false;
  let generation: number | null = null;
  let lastSequence = -1;
  /** Bumped on every reset, so a replaced decoder's late answer cannot take a placement. */
  let run = 0;
  /**
   * The run's pin: a source time and the context time it plays at. Every later packet is
   * placed by its own source time relative to this, so the page's own pauses stay pauses.
   */
  let pinnedSourceMicros = 0;
  let pinnedContext = 0;
  /** Where the audio already queued ends, so nothing is scheduled on top of it. */
  let scheduledEnd = 0;
  /** Where each decoded packet plays, by the timestamp its decoded frame comes back with. */
  const placements = new Map<number, number>();
  const scheduled = new Set<AudioBufferSourceNode>();

  const open = () => {
    if (context !== null) return;
    context = new AudioContext({ latencyHint: "interactive" });
    // Everything scheduled rides this one gain, so mute is a value change and nothing more.
    output = context.createGain();
    output.gain.value = muted ? 0 : 1;
    output.connect(context.destination);
    context.onstatechange = () => {
      if (context?.state === "suspended") options?.onBlocked?.();
    };
  };

  /** Drops everything the current capture produced, keeping the context the browser granted. */
  const reset = () => {
    run += 1;
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    lastSequence = -1;
    pinnedContext = 0;
    scheduledEnd = 0;
    placements.clear();
    for (const source of scheduled) {
      try {
        source.stop();
      } catch {}
    }
    scheduled.clear();
  };

  const close = () => {
    reset();
    generation = null;
    output = null;
    const current = context;
    context = null;
    void current?.close().catch(() => undefined);
  };

  const pin = (sourceMicros: number, at: number) => {
    pinnedSourceMicros = sourceMicros;
    pinnedContext = at;
  };

  /**
   * Where this packet's audio goes on the context clock, or null when it can no longer be
   * placed. A packet behind the clock is dropped, never shifted forward: a stalled link then
   * produces a gap instead of replaying what the page played while it was stalled.
   */
  const placement = (frame: PreviewStreamAudioFrame, now: number): number | null => {
    if (pinnedContext === 0) {
      pin(frame.timestampMicros, now + AUDIO_START_DELAY_SECONDS);
      return now + AUDIO_START_DELAY_SECONDS;
    }
    const at = pinnedContext + (frame.timestampMicros - pinnedSourceMicros) / 1_000_000;
    if (at < now) return null;
    if (at > now + AUDIO_MAX_LEAD_SECONDS) {
      // The page's own clock ran ahead (a long pause), so a fresh run starts just ahead of
      // now rather than scheduling sound far into the future.
      pin(frame.timestampMicros, now + AUDIO_START_DELAY_SECONDS);
      return now + AUDIO_START_DELAY_SECONDS;
    }
    return at;
  };

  const playFor = (opened: number) => (data: AudioData) => {
    // A decoder kept from an earlier run can still answer after its reset; its placement is gone.
    if (opened !== run) {
      data.close();
      return;
    }
    const owner = context;
    const at = placements.get(data.timestamp);
    placements.delete(data.timestamp);
    if (owner === null || owner.state !== "running" || stopped || at === undefined) {
      data.close();
      return;
    }
    const now = owner.currentTime;
    // Non-overlap is decided here, where the decoded length is known: a packet that cannot be
    // placed on its own source time without stacking on queued audio is dropped, not shifted.
    const start = Math.max(at, scheduledEnd);
    if (start < now || start > now + AUDIO_MAX_LEAD_SECONDS) {
      data.close();
      return;
    }
    const buffer = owner.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    const samples = new Float32Array(data.numberOfFrames);
    for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
      data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
      buffer.copyToChannel(samples, channel);
    }
    data.close();
    const source = owner.createBufferSource();
    source.buffer = buffer;
    source.connect(output ?? owner.destination);
    source.onended = () => scheduled.delete(source);
    scheduled.add(source);
    source.start(start);
    scheduledEnd = start + buffer.duration;
  };

  return {
    push: (frame) => {
      if (stopped) return;
      if (generation !== frame.generation) {
        // The server replaced the capture: its clock, sequence and Opus state are unrelated
        // to what is queued, so all of it goes together.
        generation = frame.generation;
        reset();
      }
      if (frame.sequence <= lastSequence) return;
      // Muting only turns the gain down, so packets keep decoding and the clock keeps its pin;
      // unmuting then resumes the same run rather than anchoring a stale backlog to now.
      open();
      const owner = context!;
      if (owner.state === "closed") return;
      if (owner.state !== "running") {
        // Autoplay policy holds the clock until a gesture; the owner retries on one.
        void owner.resume().catch(() => options?.onBlocked?.());
        return;
      }
      const start = placement(frame, owner.currentTime);
      if (start === null) return;
      try {
        decoder ??= new AudioDecoder({ output: playFor(run), error: close });
        // Configuring again per packet drops Opus state and attenuates the stream.
        if (decoder.state === "unconfigured")
          decoder.configure({
            codec: "opus",
            sampleRate: PREVIEW_STREAM_AUDIO_SAMPLE_RATE,
            numberOfChannels: PREVIEW_STREAM_AUDIO_CHANNELS,
          });
        lastSequence = frame.sequence;
        placements.set(frame.timestampMicros, start);
        scheduledEnd = Math.max(scheduledEnd, start);
        decoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: frame.timestampMicros,
            data: frame.data as Uint8Array<ArrayBuffer>,
          }),
        );
      } catch {
        close();
      }
    },
    setMuted: (next) => {
      muted = next;
      // Mute is this gain alone: decoder, clock pin, generation and queued audio all survive it.
      if (output) output.gain.value = next ? 0 : 1;
    },
    resume: () => {
      void context?.resume().catch(() => undefined);
    },
    stop: () => {
      stopped = true;
      close();
    },
  };
}

const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo npx t3 browser setup" };
};

export const previewStreamHostSetupMessage = (
  setup: PreviewStreamHostSetup,
  resolve: MFunctionType = mFallback,
) =>
  setup.need === "sandbox"
    ? resolve(
        msg(
          "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:",
        ),
      )
    : resolve(
        msg(
          "This server's host is missing libraries its browser needs. Run this once on the host, then try again:",
        ),
      );
