import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { layer } from "./buddySourceRoute.ts";

const repositoryUrl = "https://example.com/buddies.git";

const credentials = {
  missing: null,
  unscoped: [],
  // `AuthOrchestrationWriteScope` does not exist in contracts; the read scope's write
  // counterpart is `AuthOrchestrationOperateScope`, which sessions that may mutate receive.
  reader: [AuthOrchestrationReadScope],
  writer: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
} as const;

it.effect.each(["reader", "writer", "missing", "unscoped"] as const)(
  "buddy catalogs read for readers and refresh only for writers (%s)",
  (credential) =>
    Effect.gen(function* () {
      const clones = yield* Ref.make(0);
      const discards = yield* Ref.make(0);
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
      const repositories = Layer.mock(SourceControlRepositoryService, {
        cloneRepository: (input) =>
          Ref.update(clones, (count) => count + 1).pipe(
            Effect.as({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? repositoryUrl,
              repository: null,
            }),
          ),
        discardClone: () => Ref.update(discards, (count) => count + 1),
      });
      const routes = layer.pipe(
        Layer.provideMerge(auth),
        Layer.provideMerge(repositories),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-buddy-route-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (handler) => Effect.promise(() => handler.dispose()),
      );

      const catalogPath = `/api/buddies/catalog?source=${encodeURIComponent(repositoryUrl)}&refresh=1`;
      const send = (method: "GET" | "POST") =>
        Effect.promise(() =>
          server.handler(
            new Request(`http://localhost${catalogPath}`, {
              method,
              headers: { host: "example.com", "x-forwarded-proto": "https" },
            }),
          ),
        );
      const body = (response: Response) =>
        Effect.promise(
          () => response.json() as Promise<{ sources: ReadonlyArray<{ error: string | null }> }>,
        );

      const read = yield* send("GET");
      expect(read.status).toBe(
        credential === "missing" ? 401 : credential === "unscoped" ? 403 : 200,
      );
      if (read.status === 200) {
        // A GET never clones, refreshes, or deletes; it reports the missing checkout.
        expect((yield* body(read)).sources[0]?.error).not.toBeNull();
        expect(read.headers.get("cache-control")).toBe("private, no-store");
      }

      const write = yield* send("POST");
      expect(write.status).toBe(
        credential === "writer" ? 200 : credential === "missing" ? 401 : 403,
      );
      if (write.status === 200) {
        expect((yield* body(write)).sources[0]?.error).toBeNull();
      }

      expect(yield* Ref.get(clones)).toBe(credential === "writer" ? 1 : 0);
      expect(yield* Ref.get(discards)).toBe(0);
    }),
);

it.effect("serves buddy clips only to read-scoped media requests", () =>
  Effect.gen(function* () {
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateWebSocketUpgrade: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("buddy-test"),
          subject: "buddy-test",
          method: "browser-session-cookie",
          scopes: [AuthOrchestrationReadScope],
        }),
    });
    const routes = layer.pipe(
      Layer.provideMerge(auth),
      Layer.provideMerge(Layer.mock(SourceControlRepositoryService, {})),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-buddy-route-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(
        new Request("http://localhost/api/buddies/clip", {
          headers: { host: "example.com", "x-forwarded-proto": "https" },
        }),
      ),
    );
    expect(response.status).toBe(400);
  }),
);
