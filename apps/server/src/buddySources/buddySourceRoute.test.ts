import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { layer } from "./buddySourceRoute.ts";

it.effect.each(["reader", "missing", "unscoped"] as const)(
  "authenticates buddy catalogs and clips before resolving sources (%s)",
  (credential) =>
    Effect.gen(function* () {
      const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
        authenticateWebSocketUpgrade: () =>
          credential === "missing"
            ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
            : Effect.succeed({
                sessionId: AuthSessionId.make("buddy-test"),
                subject: "buddy-test",
                method: "browser-session-cookie",
                scopes: credential === "reader" ? [AuthOrchestrationReadScope] : [],
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
      for (const route of ["catalog", "clip"] as const) {
        const response = yield* Effect.promise(() =>
          server.handler(
            new Request(`http://localhost/api/buddies/${route}`, {
              headers: { host: "example.com", "x-forwarded-proto": "https" },
            }),
          ),
        );
        expect(response.status).toBe(
          credential === "missing"
            ? 401
            : credential === "unscoped"
              ? 403
              : route === "catalog"
                ? 200
                : 400,
        );
        if (credential === "reader" && route === "catalog") {
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(yield* Effect.promise(() => response.json())).toEqual({ sources: [] });
        }
      }
    }),
);
