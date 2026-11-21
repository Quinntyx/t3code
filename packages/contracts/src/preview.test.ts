import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import {
  decodePreviewStreamFrame,
  encodePreviewStreamAudioFrame,
  encodePreviewStreamVideoFrame,
} from "./preview.ts";
import {
  PreviewAutomationHost,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

describe("preview stream frames", () => {
  it("tells JPEG frames from video frames, which old servers never send", () => {
    const data = new Uint8Array([9, 8, 7]);
    const key = encodePreviewStreamVideoFrame({
      type: "key",
      codec: "avc1.42E034",
      width: 1650,
      height: 1500,
      data,
    });
    expect(decodePreviewStreamFrame(key)).toEqual({
      type: "key",
      codec: "avc1.42E034",
      width: 1650,
      height: 1500,
      data,
    });
    expect(
      decodePreviewStreamFrame(encodePreviewStreamVideoFrame({ type: "delta", data })),
    ).toEqual({
      type: "delta",
      data,
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(decodePreviewStreamFrame(jpeg)).toEqual({ type: "jpeg", data: jpeg });
    expect(decodePreviewStreamFrame(new Uint8Array([7]))).toBeNull();
  });

  it("tags audio apart from video so a viewer routes it before decoding", () => {
    const packet = new Uint8Array([0x4f, 0x70, 0x75, 0x73]);
    const frame = encodePreviewStreamAudioFrame({
      generation: 2,
      sequence: 7,
      timestampMicros: 120_000,
      data: packet,
    });
    expect(frame[0]).toBe(3);
    expect(decodePreviewStreamFrame(frame)).toEqual({
      type: "audio",
      generation: 2,
      sequence: 7,
      timestampMicros: 120_000,
      data: packet,
    });
    // An empty packet is still an audio message, not a malformed video frame.
    expect(
      decodePreviewStreamFrame(
        encodePreviewStreamAudioFrame({
          generation: 0,
          sequence: 0,
          timestampMicros: 0,
          data: new Uint8Array(0),
        }),
      ),
    ).toEqual({
      type: "audio",
      generation: 0,
      sequence: 0,
      timestampMicros: 0,
      data: new Uint8Array(0),
    });
  });

  it("keeps a gap in the source clock across packets", () => {
    const read = (timestampMicros: number) =>
      decodePreviewStreamFrame(
        encodePreviewStreamAudioFrame({
          generation: 1,
          sequence: 1,
          timestampMicros,
          data: new Uint8Array([1]),
        }),
      );
    // A page that stops for a second must not read as back-to-back packets.
    expect(read(0)).toMatchObject({ timestampMicros: 0 });
    expect(read(1_020_000)).toMatchObject({ timestampMicros: 1_020_000 });
    // A new capture's sequence restarting at 0 is still a different packet.
    expect(read(1_040_000)).toMatchObject({ sequence: 1, timestampMicros: 1_040_000 });
  });

  it("refuses an audio message too short to carry its header", () => {
    expect(decodePreviewStreamFrame(new Uint8Array([3, 0, 0]))).toBeNull();
  });
});

describe("PreviewAutomationInvalidSelectorError", () => {
  const invalidSelector = (selectorKind: "locator" | "selector") =>
    new PreviewAutomationInvalidSelectorError({
      operation: "click",
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("claude"),
      clientId: "desktop",
      connectionId: "connection-1",
      requestId: "request-1",
      timeoutMs: 15_000,
      remoteTag: "Error",
      remoteMessageLength: 0,
      cause: null,
      selectorKind,
      selectorLength: 42,
    });

  it("tells agents which locator forms are accepted and where CSS goes", () => {
    const { message } = invalidSelector("locator");
    expect(message).toContain("aria-ref=");
    expect(message).toMatch(/role/);
    expect(message).toMatch(/text/);
    expect(message).toMatch(/CSS[^.]*\bselector\b/);
  });

  it("points an invalid CSS selector at the locator alternative", () => {
    const { message } = invalidSelector("selector");
    expect(message).toMatch(/CSS/);
    expect(message).toMatch(/\blocator\b/);
    expect(message).toContain("aria-ref=");
  });
});
