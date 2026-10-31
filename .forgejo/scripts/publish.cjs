const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

async function publishPackage({ baseUrl, token, owner, files, request = fetch }) {
  const headers = { Authorization: `Basic ${Buffer.from(`${owner}:${token}`).toString("base64")}` };
  const send = (name, method, body) =>
    request(new URL(encodeURIComponent(name), baseUrl), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(600_000),
    });
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  const mutable = (name) => name.endsWith(".yml") || name === "manifest.json";
  for (const [name, body] of [...files].sort(
    ([a], [b]) => Number(mutable(a)) - Number(mutable(b)),
  )) {
    if (mutable(name)) {
      const deleted = await send(name, "DELETE");
      if (!deleted.ok && deleted.status !== 404)
        throw new Error(`DELETE ${name}: ${deleted.status}`);
    }
    const response = await send(name, "PUT", body);
    if (response.status === 409 && !mutable(name)) {
      const existing = await send(name, "GET");
      if (!existing.ok || digest(Buffer.from(await existing.arrayBuffer())) !== digest(body)) {
        throw new Error(`Immutable asset differs: ${name}; publish a new version`);
      }
    } else if (!response.ok) {
      throw new Error(`PUT ${name}: ${response.status} ${await response.text()}`);
    }
    console.log(`Published ${name}`);
  }
}

module.exports = { publishPackage };

if (require.main === module) {
  const [directory, packageName, version] = process.argv.slice(2);
  const origin = process.env.FORGEJO_SERVER_URL;
  const owner = process.env.FORGEJO_REPOSITORY_OWNER;
  const token = process.env.PACKAGES_TOKEN;
  if (!directory || !packageName || !version || !origin || !owner || !token)
    throw new Error(
      "Usage: publish.cjs DIRECTORY PACKAGE VERSION; requires FORGEJO_SERVER_URL, FORGEJO_REPOSITORY_OWNER, PACKAGES_TOKEN",
    );
  const files = new Map(
    readdirSync(directory, { withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => [file.name, readFileSync(join(directory, file.name))]),
  );
  if (files.size === 0) throw new Error(`No files in ${directory}`);
  publishPackage({
    baseUrl: `${origin}/api/packages/${owner}/generic/${packageName}/${version}/`,
    token,
    owner,
    files,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
