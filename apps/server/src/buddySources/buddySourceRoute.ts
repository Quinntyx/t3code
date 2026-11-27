import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";

import { requestUrl } from "../requestUrl.ts";
import { buddyCatalogEntries, buddyClipPath } from "./BuddySourceService.ts";

const CATALOG_ROUTE = "/api/buddies/catalog";
const CLIP_ROUTE = "/api/buddies/clip/*";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });

const query = (url: URL) => ({
  source: url.searchParams.get("source") ?? "",
  buddy: url.searchParams.get("buddy") ?? "",
  file: url.searchParams.get("file") ?? "",
});

const catalog = Effect.fn("BuddySourceRoute.catalog")(function* (
  lock: Semaphore.Semaphore,
  sync: boolean,
) {
  // Re-cloning configured sources writes to disk, so it needs the write-side scope; a plain
  // read of checkouts that already exist stays behind the read scope.
  yield* authenticateMediaRequest(
    sync ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
  );
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (url._tag === "None") return json({ error: "Bad request." }, 400);
  const sources = url.value.searchParams.getAll("source").filter((entry) => entry.length > 0);
  const refresh = sync && url.value.searchParams.get("refresh") === "1";
  const entries = yield* buddyCatalogEntries(sources, { sync, refresh, lock });
  return json({ sources: entries });
});

const catalogResponse = (lock: Semaphore.Semaphore, sync: boolean) =>
  catalog(lock, sync).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  );

// One semaphore per route layer: concurrent clones share the staging paths without leaking
// state across layers or tests.
const layerCatalogRoute = Layer.unwrap(
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    return Layer.mergeAll(
      HttpRouter.add("GET", CATALOG_ROUTE, catalogResponse(lock, false)),
      HttpRouter.add("POST", CATALOG_ROUTE, catalogResponse(lock, true)),
    );
  }),
);

const layerClipRoute = HttpRouter.add(
  "GET",
  CLIP_ROUTE,
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (url._tag === "None") return HttpServerResponse.text("Bad Request", { status: 400 });
    const { source, buddy, file } = query(url.value);
    if (source.length === 0 || buddy.length === 0 || file.length === 0) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const filePath = yield* buddyClipPath({ repositoryUrl: source, buddyId: buddy, file });
    if (filePath === null) return HttpServerResponse.text("Not Found", { status: 404 });
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs
      .readFile(filePath)
      .pipe(Effect.orElseSucceed((): Uint8Array | null => null));
    if (bytes === null) return HttpServerResponse.text("Not Found", { status: 404 });
    return HttpServerResponse.uint8Array(bytes, {
      contentType: "video/webm",
      // Clips are immutable for a given source commit; a short private cache is enough.
      headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const layer = Layer.mergeAll(layerCatalogRoute, layerClipRoute);
