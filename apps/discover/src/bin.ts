#!/usr/bin/env node
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The standalone Node CLI owns its private state directory.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This adapter accepts inbound HTTP; it never makes outbound authorized requests.
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- CLI paths must work before the Effect runtime is constructed.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import * as Broker from "./Broker.ts";
import { loadServicesConfig, servicesConfigPath } from "./config.ts";
import { handle } from "./http.ts";
import { autostartServices, buildServices, startAll, stopAll } from "./services/index.ts";

const encodeMembers = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))),
);

const encodeServices = (
  services: ReadonlyArray<{
    serviceId: string;
    kind: string;
    label: string;
    health: string;
    capabilities: ReadonlyArray<string>;
  }>,
  configPath: string,
) =>
  JSON.stringify(
    {
      config: configPath,
      services: services.map((service) => ({
        serviceId: service.serviceId,
        kind: service.kind,
        label: service.label,
        health: service.health,
        capabilities: service.capabilities,
      })),
    },
    null,
    2,
  );

const usage =
  "t3discover <serve|pair|members|services|revoke member-id> [--host 127.0.0.1] [--port 3775] [--home ~/.t3discover] [--origin https://discover.example]";
const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "3775" },
    home: { type: "string", default: NodePath.join(NodeOS.homedir(), ".t3discover") },
    origin: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const command = positionals[0];
if (values.help) {
  process.stdout.write(`${usage}\n`);
} else if (
  !["serve", "pair", "members", "services", "revoke"].includes(command ?? "") ||
  positionals.length !== (command === "revoke" ? 2 : 1)
) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 1;
} else {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Port must be between 1 and 65535.");
  const host = values.host;
  const origin = new URL(
    values.origin ?? `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
  );
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Origin must be an HTTP(S) origin without credentials or a path.");
  process.umask(0o077);
  const home = NodePath.resolve(values.home);
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(home, 0o700);
  // Services are built before the broker so its directory can advertise them; both runtimes stay
  // alive for the process lifetime so supervised children keep their fibers.
  const servicesRuntime = ManagedRuntime.make(
    Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
  );
  const configured = await servicesRuntime.runPromise(
    loadServicesConfig(home).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          // A malformed file must not start a broker that silently advertises nothing.
          process.stderr.write(`t3discover: ${error.path}: ${error.message}\n`);
          process.exit(1);
        }),
      ),
    ),
  );
  const built = await servicesRuntime.runPromise(buildServices(configured));
  const runtime = ManagedRuntime.make(
    Broker.layer(NodePath.join(home, "discover.sqlite"), built.discoverable),
  );
  if (command !== "serve") {
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const broker = yield* Broker.Broker;
          if (command === "pair") {
            const code = yield* broker.pair();
            yield* Effect.sync(() =>
              process.stdout.write(`${origin.origin}/discover#token=${encodeURIComponent(code)}\n`),
            );
          } else if (command === "members") {
            const members = yield* broker.members();
            yield* Effect.sync(() => process.stdout.write(`${encodeMembers(members)}\n`));
          } else if (command === "services") {
            const services = yield* broker.services();
            yield* Effect.sync(() =>
              process.stdout.write(`${encodeServices(services, servicesConfigPath(home))}\n`),
            );
          } else {
            yield* broker.revoke(positionals[1]!);
          }
        }),
      );
    } catch {
      process.stderr.write("Unable to update discovery. Check the broker home and permissions.\n");
      process.exitCode = 1;
    } finally {
      await runtime.dispose();
      await servicesRuntime.dispose();
    }
  } else {
    const server = NodeHttp.createServer(
      { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 },
      async (incoming, outgoing) => {
        try {
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > 64 * 1024) {
              outgoing.writeHead(413, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "cache-control": "no-store",
                connection: "close",
              });
              outgoing.end('{"error":"Payload too large."}');
              return;
            }
            chunks.push(bytes);
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const method = incoming.method ?? "GET";
          const request = new Request(new URL(incoming.url ?? "/", origin), {
            method,
            headers,
            ...(method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
          });
          const result = await runtime.runPromise(handle(request));
          outgoing.writeHead(result.status, Object.fromEntries(result.headers));
          outgoing.end(await result.text());
        } catch {
          if (!outgoing.headersSent)
            outgoing.writeHead(500, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
          outgoing.end('{"error":"Broker request failed."}');
        }
      },
    );
    const stop = () => {
      server.close(() => {
        void servicesRuntime
          .runPromise(stopAll(built.managed))
          .then(() => runtime.dispose())
          .then(() => servicesRuntime.dispose());
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.once("error", () => {
      process.stderr.write("Unable to listen on the configured broker address.\n");
      process.exitCode = 1;
      // Supervisors own their own scopes, so disposing the runtimes would leave them running.
      void servicesRuntime
        .runPromise(stopAll(built.managed))
        .then(() => runtime.dispose())
        .then(() => servicesRuntime.dispose());
    });
    await servicesRuntime.runPromise(startAll(autostartServices(configured, built)));
    server.listen(port, host, () =>
      process.stderr.write(`t3discover listening on ${origin.origin}\n`),
    );
  }
}
