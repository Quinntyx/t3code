const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { createMobileManifest } = require("./mobile-manifest.cjs");

const [platform, exportDirectory, outputDirectory] = process.argv.slice(2);
if (
  !["ios", "android"].includes(platform) ||
  !exportDirectory ||
  !outputDirectory ||
  !process.env.MOBILE_ASSET_BASE_URL
) {
  throw new Error(
    "Usage: prepare-mobile.cjs PLATFORM EXPORT_DIRECTORY OUTPUT_DIRECTORY; requires MOBILE_ASSET_BASE_URL",
  );
}
const root = resolve(__dirname, "../..");
const mobile = join(root, "apps/mobile");
const commandJson = (args) =>
  JSON.parse(
    execFileSync("pnpm", ["exec", ...args], {
      cwd: mobile,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
const { runtimeVersion } = commandJson([
  "expo-updates",
  "runtimeversion:resolve",
  "--platform",
  platform,
  "--workflow",
  "managed",
]);
if (typeof runtimeVersion !== "string" || !runtimeVersion)
  throw new Error("Expo did not resolve a native runtime version");
const config = commandJson(["expo", "config", "--json", "--type", "public"]);
const directory = resolve(exportDirectory);
const metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
const exported = metadata.fileMetadata[platform];
if (!exported) throw new Error(`Missing ${platform} export`);
const files = new Map(
  [exported.bundle, ...exported.assets.map((asset) => asset.path)].map((path) => [
    path,
    readFileSync(join(directory, path)),
  ]),
);
const { manifest, uploads } = createMobileManifest({
  platform,
  runtimeVersion,
  baseUrl: process.env.MOBILE_ASSET_BASE_URL,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  createdAt: new Date().toISOString(),
  config: { ...config, runtimeVersion },
  metadata,
  files,
});
mkdirSync(outputDirectory, { recursive: true });
for (const [name, content] of uploads) writeFileSync(join(outputDirectory, name), content);
writeFileSync(join(outputDirectory, "manifest.json"), JSON.stringify(manifest));
console.log(
  JSON.stringify({
    platform,
    runtimeVersion,
    assets: uploads.size,
    manifest: join(outputDirectory, "manifest.json"),
  }),
);
