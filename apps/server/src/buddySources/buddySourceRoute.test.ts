import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layer } from "./buddySourceRoute.ts";

const credentials = {
  missing: null,
  unscoped: [],
  reader: [AuthOrchestrationReadScope],
} as const;

const manifest = {
  schemaVersion: 1,
  id: "hero",
  name: "Hero",
  description: "A buddy",
  author: "Tester",
  license: "MIT",
  aspectRatio: 1,
  clips: { idle: "idle.webm" },
};

it.effect.each(["reader", "missing", "unscoped"] as const)(
  "buddy catalog reads configured folders only for read-scoped callers (%s)",
  (credential) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const folder = path.join(config.baseDir, "buddies");
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(path.join(folder, "buddy.json"), JSON.stringify(manifest));
      yield* fs.writeFileString(path.join(folder, "idle.webm"), "webm-bytes");

      const scopes = credentials[credential];
      const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
        authenticateWebSocketUpgrade: () =>
          scopes === null
            ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("buddy-test"),
                subject: "buddy-test",
                method: "browser-session-cookie",
                scopes,
              }),
      });
      const settingsLayer = Layer.mock(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          buddyFolders: [folder],
        }),
      });
      const routes = layer.pipe(
        Layer.provideMerge(auth),
        Layer.provideMerge(settingsLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (handler) => Effect.promise(() => handler.dispose()),
      );

      const response = yield* Effect.promise(() =>
        server.handler(
          new Request("http://localhost/api/buddies/catalog", {
            headers: { host: "example.com", "x-forwarded-proto": "https" },
          }),
        ),
      );
      expect(response.status).toBe(
        credential === "missing" ? 401 : credential === "unscoped" ? 403 : 200,
      );
      if (response.status === 200) {
        const body = (yield* Effect.promise(() => response.json())) as {
          folders: ReadonlyArray<{ folderPath: string; buddies: ReadonlyArray<{ id: string }> }>;
        };
        expect(body.folders).toHaveLength(1);
        expect(body.folders[0]?.folderPath).toBe(folder);
        expect(body.folders[0]?.buddies.map((buddy) => buddy.id)).toEqual(["hero"]);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-buddy-route-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("serves clips only from server-configured folders", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const allowed = path.join(config.baseDir, "allowed");
    const unconfigured = path.join(config.baseDir, "unconfigured");
    for (const dir of [allowed, unconfigured]) {
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "buddy.json"), JSON.stringify(manifest));
      yield* fs.writeFileString(path.join(dir, "idle.webm"), "webm-bytes");
    }

    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateWebSocketUpgrade: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("buddy-test"),
          subject: "buddy-test",
          method: "browser-session-cookie",
          scopes: [AuthOrchestrationReadScope],
        }),
    });
    const settingsLayer = Layer.mock(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        buddyFolders: [allowed],
      }),
    });
    const routes = layer.pipe(
      Layer.provideMerge(auth),
      Layer.provideMerge(settingsLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (handler) => Effect.promise(() => handler.dispose()),
    );

    const missingParams = yield* Effect.promise(() =>
      server.handler(
        new Request("http://localhost/api/buddies/clip", {
          headers: { host: "example.com", "x-forwarded-proto": "https" },
        }),
      ),
    );
    expect(missingParams.status).toBe(400);

    const okClip = yield* Effect.promise(() =>
      server.handler(
        new Request(
          `http://localhost/api/buddies/clip?folder=${encodeURIComponent(allowed)}&buddy=hero&file=idle.webm`,
          { headers: { host: "example.com", "x-forwarded-proto": "https" } },
        ),
      ),
    );
    expect(okClip.status).toBe(200);
    expect(okClip.headers.get("content-type")).toBe("video/webm");
    expect(yield* Effect.promise(() => okClip.text())).toBe("webm-bytes");

    const blockedClip = yield* Effect.promise(() =>
      server.handler(
        new Request(
          `http://localhost/api/buddies/clip?folder=${encodeURIComponent(unconfigured)}&buddy=hero&file=idle.webm`,
          { headers: { host: "example.com", "x-forwarded-proto": "https" } },
        ),
      ),
    );
    expect(blockedClip.status).toBe(404);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-buddy-route-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
