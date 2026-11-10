import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

const layerCatalogRoute = HttpRouter.add(
  "GET",
  CATALOG_ROUTE,
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (url._tag === "None") return json({ error: "Bad request." }, 400);
    // Every configured source is pulled on load; `refresh` forces a re-clone.
    const sources = url.value.searchParams.getAll("source").filter((entry) => entry.length > 0);
    const refresh = url.value.searchParams.get("refresh") === "1";
    const entries = yield* buddyCatalogEntries(sources, { refresh });
    return json({ sources: entries });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
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
