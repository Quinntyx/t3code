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
import * as ServerSettings from "../serverSettings.ts";
import { buddyCatalogEntries, buddyClipPath } from "./BuddySourceService.ts";

const CATALOG_ROUTE = "/api/buddies/catalog";
const CLIP_ROUTE = "/api/buddies/clip";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });

const query = (url: URL) => ({
  folder: url.searchParams.get("folder") ?? "",
  buddy: url.searchParams.get("buddy") ?? "",
  file: url.searchParams.get("file") ?? "",
});

const layerCatalogRoute = HttpRouter.add(
  "GET",
  CATALOG_ROUTE,
  Effect.gen(function* () {
    yield* authenticateMediaRequest(AuthOrchestrationReadScope);
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const folders = yield* buddyCatalogEntries(settings.buddyFolders);
    return json({ folders });
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
    const { folder, buddy, file } = query(url.value);
    if (folder.length === 0 || buddy.length === 0 || file.length === 0) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const filePath = yield* buddyClipPath({
      configuredFolders: settings.buddyFolders,
      folderPath: folder,
      buddyId: buddy,
      file,
    });
    if (filePath === null) return HttpServerResponse.text("Not Found", { status: 404 });
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs
      .readFile(filePath)
      .pipe(Effect.orElseSucceed((): Uint8Array | null => null));
    if (bytes === null) return HttpServerResponse.text("Not Found", { status: 404 });
    return HttpServerResponse.uint8Array(bytes, {
      contentType: "video/webm",
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
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
