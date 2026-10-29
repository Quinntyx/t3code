import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  cached: new Map<string, string>(),
  lookups: [] as string[],
}));

vi.mock("expo-image", () => ({
  Image: {
    getCachePathAsync: async (cacheKey: string) => {
      harness.lookups.push(cacheKey);
      return harness.cached.get(cacheKey) ?? null;
    },
  },
}));

import { assetImageCacheKey } from "../lib/assetImageSource";
import { useCachedAssetImageUri } from "./cached-asset-image";

const environmentId = EnvironmentId.make("environment-1");

function setup() {
  harness.cached.clear();
  harness.lookups.length = 0;
}

it("shows a disk-cached immutable image before its URL is minted", async () => {
  setup();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const attachment = { _tag: "attachment", attachmentId: "a" } as const;
  const missing = { _tag: "attachment", attachmentId: "missing" } as const;
  const file = {
    _tag: "media-file",
    threadId: ThreadId.make("thread-1"),
    path: "/shot.png",
  } as const;
  harness.cached.set(assetImageCacheKey(environmentId, attachment)!, "/cache/a.png");
  const seen: Record<string, string | null> = {};
  const report = (name: string, uri: string | null) => {
    seen[name] = uri;
  };
  function Probe(props: {
    readonly name: string;
    readonly resource: Parameters<typeof useCachedAssetImageUri>[1];
    readonly signedUri: string | null;
    readonly report: (name: string, uri: string | null) => void;
  }) {
    props.report(
      props.name,
      useCachedAssetImageUri(environmentId, props.resource, props.signedUri),
    );
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (signedUri: string | null) => (
    <>
      <Probe name="attachment" resource={attachment} signedUri={signedUri} report={report} />
      <Probe name="missing" resource={missing} signedUri={null} report={report} />
      <Probe name="file" resource={file} signedUri={null} report={report} />
    </>
  );
  try {
    await act(async () => root.render(render(null)));
    expect(seen).toEqual({ attachment: "file:///cache/a.png", missing: null, file: null });
    // A file's bytes can change under its path, so it waits for the mint's revision.
    expect(harness.lookups).toHaveLength(2);

    await act(async () => root.render(render("https://example.test/a.png")));
    expect(seen.attachment).toBe("https://example.test/a.png");
  } finally {
    await act(async () => root.unmount());
  }
});
