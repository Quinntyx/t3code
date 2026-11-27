import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import { ConnectionTransientError, SshConnectionTarget, type PreparedConnection } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";

const sshTarget = (connectionId: string) =>
  new SshConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Test environment",
    connectionId,
  });

const ENTRY: ConnectionCatalogEntry = {
  target: sshTarget("ssh-first"),
  profile: Option.none(),
  enabled: true,
  alternateRoutes: [{ target: sshTarget("ssh-second"), profile: Option.none() }],
};

describe("ConnectionDriver", () => {
  it.effect("reports preparing before each route it prepares", () =>
    Effect.gen(function* () {
      const stages = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ConnectionResolver.ConnectionResolver)({
              prepare: (entry) =>
                Effect.succeed({
                  environmentId: entry.target.environmentId,
                  label: entry.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: entry.target,
                } satisfies PreparedConnection),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () =>
                Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "Socket closed." }),
                ),
            }),
            Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({}),
            // SSH routes have no HTTP check, so the driver never sends a request.
            FetchHttpClient.layer,
          ),
        ),
      );

      yield* driver
        .connect(ENTRY, (progress) => Ref.update(stages, (all) => [...all, progress.stage]))
        .pipe(Effect.scoped, Effect.flip);

      expect(yield* Ref.get(stages)).toEqual([
        "preparing",
        "preparing",
        "opening",
        "preparing",
        "opening",
      ]);
    }),
  );

  it.effect(
    "tries the matching route without checking routes when skipRouteCheckForId matches, and falls back if it fails",
    () =>
      Effect.gen(function* () {
        const checked = yield* Ref.make<ReadonlyArray<string>>([]);
        const attempted = yield* Ref.make<ReadonlyArray<string>>([]);
        const entry: ConnectionCatalogEntry = {
          target: sshTarget("first"),
          profile: Option.none(),
          enabled: true,
          alternateRoutes: [
            { target: sshTarget("second"), profile: Option.none() },
            { target: sshTarget("third"), profile: Option.none() },
          ],
        };

        const direct = yield* ConnectionDriver.connectOverRoutes(
          entry,
          (route) =>
            Ref.update(checked, (all) => [
              ...all,
              (route.target as SshConnectionTarget).connectionId,
            ]).pipe(Effect.as<ConnectionDriver.RouteCheck>("answered")),
          (route) => {
            const id = (route.target as SshConnectionTarget).connectionId;
            return Ref.update(attempted, (all) => [...all, id]).pipe(
              Effect.as({
                prepared: {
                  environmentId: route.target.environmentId,
                  label: route.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: route.target,
                },
                session: {} as RpcSession.RpcSession,
              }),
            );
          },
          { skipRouteCheckForId: "first" },
        ).pipe(Effect.scoped);

        expect((direct.prepared.target as SshConnectionTarget).connectionId).toBe("first");
        expect(yield* Ref.get(checked)).toEqual([]);
        expect(yield* Ref.get(attempted)).toEqual(["first"]);

        // A non-matching route ID still runs route checks before connecting.
        yield* Ref.set(checked, []);
        yield* Ref.set(attempted, []);
        yield* ConnectionDriver.connectOverRoutes(
          entry,
          (route) =>
            Ref.update(checked, (all) => [
              ...all,
              (route.target as SshConnectionTarget).connectionId,
            ]).pipe(Effect.as<ConnectionDriver.RouteCheck>("answered")),
          (route) => {
            const id = (route.target as SshConnectionTarget).connectionId;
            return Ref.update(attempted, (all) => [...all, id]).pipe(
              Effect.as({
                prepared: {
                  environmentId: route.target.environmentId,
                  label: route.target.label,
                  httpBaseUrl: "http://127.0.0.1:1",
                  socketUrl: "ws://127.0.0.1:1/ws",
                  httpAuthorization: null,
                  target: route.target,
                },
                session: {} as RpcSession.RpcSession,
              }),
            );
          },
          { skipRouteCheckForId: "other" },
        ).pipe(Effect.scoped);
        expect(yield* Ref.get(checked)).toContain("first");

        // When the first route fails, remaining routes still run their checks and connect.
        yield* Ref.set(checked, []);
        yield* Ref.set(attempted, []);
        const fallback = yield* ConnectionDriver.connectOverRoutes(
          entry,
          (route) =>
            Ref.update(checked, (all) => [
              ...all,
              (route.target as SshConnectionTarget).connectionId,
            ]).pipe(Effect.as<ConnectionDriver.RouteCheck>("answered")),
          (route) => {
            const id = (route.target as SshConnectionTarget).connectionId;
            return Ref.update(attempted, (all) => [...all, id]).pipe(
              Effect.andThen(
                id === "first"
                  ? Effect.fail(
                      new ConnectionTransientError({
                        reason: "transport",
                        detail: "Socket closed.",
                      }),
                    )
                  : Effect.succeed({
                      prepared: {
                        environmentId: route.target.environmentId,
                        label: route.target.label,
                        httpBaseUrl: "http://127.0.0.1:1",
                        socketUrl: "ws://127.0.0.1:1/ws",
                        httpAuthorization: null,
                        target: route.target,
                      },
                      session: {} as RpcSession.RpcSession,
                    }),
              ),
            );
          },
          { skipRouteCheckForId: "first" },
        ).pipe(Effect.scoped);

        expect((fallback.prepared.target as SshConnectionTarget).connectionId).toBe("second");
        expect(yield* Ref.get(checked)).not.toContain("first");
        expect(yield* Ref.get(checked)).toContain("second");
        expect(yield* Ref.get(attempted)).toEqual(["first", "second"]);

        // Two-route fallback: when the skipped first route fails transiently, the lone remaining
        // route still runs its check and is skipped if silent rather than dialed unchecked.
        const twoRouteChecked = yield* Ref.make<ReadonlyArray<string>>([]);
        const twoRouteAttempted = yield* Ref.make<ReadonlyArray<string>>([]);
        const twoRouteEntry: ConnectionCatalogEntry = {
          target: sshTarget("tailscale"),
          profile: Option.none(),
          enabled: true,
          alternateRoutes: [{ target: sshTarget("dead-lan"), profile: Option.none() }],
        };
        const twoRouteError = yield* ConnectionDriver.connectOverRoutes(
          twoRouteEntry,
          (route) =>
            Ref.update(twoRouteChecked, (all) => [
              ...all,
              (route.target as SshConnectionTarget).connectionId,
            ]).pipe(Effect.as<ConnectionDriver.RouteCheck>("silent")),
          (route) => {
            const id = (route.target as SshConnectionTarget).connectionId;
            return Ref.update(twoRouteAttempted, (all) => [...all, id]).pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Socket closed.",
                  }),
                ),
              ),
            );
          },
          { skipRouteCheckForId: "tailscale" },
        ).pipe(Effect.scoped, Effect.flip);

        expect(twoRouteError.reason).toBe("transport");
        expect(yield* Ref.get(twoRouteChecked)).toEqual(["dead-lan"]);
        expect(yield* Ref.get(twoRouteAttempted)).toEqual(["tailscale"]);
      }),
  );
});
