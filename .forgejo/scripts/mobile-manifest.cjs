const { createHash } = require("node:crypto");

function createMobileManifest({
  platform,
  runtimeVersion,
  baseUrl,
  revision,
  createdAt,
  config,
  metadata,
  files,
}) {
  const exported = metadata.fileMetadata[platform];
  if (!exported) throw new Error(`Missing ${platform} export`);
  const uploads = new Map();
  const asset = (path, ext) => {
    const content = files.get(path);
    if (!content) throw new Error(`Missing exported file: ${path}`);
    const digest = createHash("sha256").update(content);
    const hash = digest.copy().digest("base64url");
    const key = digest.digest("hex");
    const name = `${key}.${ext}`;
    uploads.set(name, content);
    return {
      key,
      hash,
      fileExtension: `.${ext}`,
      contentType:
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          svg: "image/svg+xml",
          ttf: "font/ttf",
          otf: "font/otf",
          bundle: "application/javascript",
        }[ext] ?? "application/octet-stream",
      url: new URL(name, new URL(`${platform}-${encodeURIComponent(runtimeVersion)}/`, baseUrl))
        .href,
    };
  };
  const launchAsset = asset(exported.bundle, "bundle");
  const idHash = createHash("sha256")
    .update(`${platform}:${runtimeVersion}:${revision}:${launchAsset.hash}`)
    .digest("hex");
  const id = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-4${idHash.slice(13, 16)}-8${idHash.slice(17, 20)}-${idHash.slice(20, 32)}`;
  return {
    manifest: {
      id,
      createdAt,
      runtimeVersion,
      launchAsset,
      assets: exported.assets.map(({ path, ext }) => asset(path, ext)),
      metadata: {},
      extra: { expoClient: config },
    },
    uploads,
  };
}

module.exports = { createMobileManifest };
