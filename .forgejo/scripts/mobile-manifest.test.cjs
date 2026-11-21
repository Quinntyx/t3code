const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const { createMobileManifest } = require("./mobile-manifest.cjs");

test("exports a runtime-bound Expo manifest with immutable, verified asset URLs", () => {
  const bundle = Buffer.from("Hermes bundle");
  const image = Buffer.from("image bytes");
  const input = {
    platform: "android",
    runtimeVersion: "native-fingerprint",
    baseUrl: "https://tailnet.example/api/packages/me/generic/mobile/",
    revision: "commit-sha",
    createdAt: "2026-10-30T06:00:00.000Z",
    config: { name: "Fork", runtimeVersion: "native-fingerprint" },
    metadata: {
      fileMetadata: {
        android: { bundle: "_expo/index.hbc", assets: [{ path: "assets/icon", ext: "png" }] },
      },
    },
    files: new Map([
      ["_expo/index.hbc", bundle],
      ["assets/icon", image],
    ]),
  };
  const { manifest, uploads } = createMobileManifest(input);
  const expectedHash = createHash("sha256").update(bundle).digest("base64url");
  assert.equal(manifest.runtimeVersion, input.runtimeVersion);
  assert.equal(manifest.launchAsset.hash, expectedHash);
  assert.match(
    manifest.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(manifest.assets[0].contentType, "image/png");
  assert.deepEqual(manifest.extra.expoClient, input.config);
  for (const asset of [manifest.launchAsset, ...manifest.assets]) {
    assert.ok(asset.url.startsWith(`${input.baseUrl}android-native-fingerprint/`));
    assert.ok(uploads.has(new URL(asset.url).pathname.split("/").at(-1)));
  }
  assert.notEqual(
    createMobileManifest({ ...input, runtimeVersion: "next-native" }).manifest.launchAsset.url,
    manifest.launchAsset.url,
  );
  assert.equal(createMobileManifest(input).manifest.id, manifest.id);
  assert.notEqual(
    createMobileManifest({ ...input, revision: "next-commit" }).manifest.id,
    manifest.id,
  );
  assert.throws(() => createMobileManifest({ ...input, platform: "ios" }), /Missing ios export/);
  assert.throws(
    () => createMobileManifest({ ...input, files: new Map() }),
    /Missing exported file/,
  );
});
