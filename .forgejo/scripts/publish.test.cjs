const assert = require("node:assert/strict");
const { test } = require("node:test");
const { publishPackage } = require("./publish.cjs");

test("publishes immutable payloads before replacing the feed and propagates failures", async () => {
  const calls = [];
  const files = new Map([
    ["latest-linux.yml", Buffer.from("version: 1.0.0")],
    ["app.AppImage", Buffer.from("binary")],
  ]);
  const request = async (url, options) => {
    const name = new URL(url).pathname.split("/").at(-1);
    calls.push(`${options.method} ${name}`);
    const status =
      options.method === "DELETE"
        ? 204
        : options.method === "GET"
          ? 200
          : name === "app.AppImage"
            ? 409
            : 201;
    return new Response(options.method === "GET" ? files.get(name) : null, { status });
  };
  await publishPackage({
    baseUrl: "https://forgejo.example/api/packages/me/generic/app/stable/",
    token: "secret",
    owner: "me",
    files,
    request,
  });
  assert.deepEqual(calls, [
    "PUT app.AppImage",
    "GET app.AppImage",
    "DELETE latest-linux.yml",
    "PUT latest-linux.yml",
  ]);
  const failed = [];
  await assert.rejects(
    publishPackage({
      baseUrl: "https://forgejo.example/feed/",
      token: "secret",
      owner: "me",
      files,
      request: async (url, options) => {
        failed.push(options.method);
        return new Response("denied", { status: 403 });
      },
    }),
    /403/,
  );
  assert.deepEqual(failed, ["PUT"]);
  await assert.rejects(
    publishPackage({
      baseUrl: "https://forgejo.example/feed/",
      token: "secret",
      owner: "me",
      files,
      request: async (_url, options) =>
        new Response(options.method === "GET" ? "different binary" : null, {
          status: options.method === "GET" ? 200 : 409,
        }),
    }),
    /Immutable asset differs/,
  );
});
