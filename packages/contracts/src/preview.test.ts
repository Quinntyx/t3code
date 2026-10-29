import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decodePreviewStreamFrame, encodePreviewStreamVideoFrame } from "./preview.ts";
import { PreviewAutomationHost, PreviewAutomationStatus } from "./previewAutomation.ts";

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
});
