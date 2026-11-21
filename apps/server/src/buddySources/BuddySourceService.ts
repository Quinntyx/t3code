import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";

/** One buddy folder in a source repository. */
export interface BuddyManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  /** Clip width divided by height. */
  readonly aspectRatio: number;
  /** Buddy state slot to clip file name. */
  readonly clips: Readonly<Record<string, string>>;
}

export interface BuddySourceCatalogEntry {
  readonly repositoryUrl: string;
  readonly buddies: ReadonlyArray<BuddyManifest>;
  /** Why this source could not be read, so one bad source does not hide the rest. */
  readonly error: string | null;
}

const BuddyManifestJson = Schema.Struct({
  schemaVersion: Schema.optionalKey(Schema.Number),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  license: Schema.optionalKey(Schema.String),
  aspectRatio: Schema.Number,
  clips: Schema.Record(Schema.String, Schema.String),
});

const decodeBuddyManifest = Schema.decodeUnknownOption(BuddyManifestJson);

// Clones for one source must not overlap: two refreshes share a staging directory.
let syncLock: Semaphore.Semaphore | undefined;
const syncSemaphore = Effect.gen(function* () {
  syncLock ??= yield* Semaphore.make(1);
  return syncLock;
});

const MANIFEST_FILE = "buddy.json";
const CLIP_SUFFIX = ".webm";

/** A readable, collision-free directory name for a remote URL. */
const sourceSlug = (repositoryUrl: string): string => {
  const withoutScheme = repositoryUrl.replace(/^[a-z+]+:\/\//i, "").replace(/\.git$/i, "");
  return withoutScheme.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
};

const isPlainSegment = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("\0");

const parseBuddyManifest = (raw: string): BuddyManifest | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const decoded = decodeBuddyManifest(parsed);
  if (decoded._tag === "None") return null;
  const value = decoded.value;
  if (!isPlainSegment(value.id)) return null;
  if (!Number.isFinite(value.aspectRatio) || value.aspectRatio <= 0) return null;
  const clips: Record<string, string> = {};
  for (const [slot, file] of Object.entries(value.clips)) {
    // Only sibling clip files, so a manifest cannot point outside its folder.
    if (!isPlainSegment(file) || !file.endsWith(CLIP_SUFFIX)) return null;
    clips[slot] = file;
  }
  if (Object.keys(clips).length === 0) return null;
  return {
    id: value.id,
    name: value.name,
    description: value.description ?? "",
    author: value.author ?? "",
    license: value.license ?? "",
    aspectRatio: value.aspectRatio,
    clips,
  };
};

const checkoutDir = Effect.fn("buddySources.checkoutDir")(function* (repositoryUrl: string) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "userdata", "buddy-sources", sourceSlug(repositoryUrl));
});

const readManifests = Effect.fn("buddySources.readManifests")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const manifests: Array<BuddyManifest> = [];
  for (const entry of entries.toSorted()) {
    if (!isPlainSegment(entry)) continue;
    const manifestPath = path.join(directory, entry, MANIFEST_FILE);
    const raw = yield* fs
      .readFileString(manifestPath)
      .pipe(Effect.orElseSucceed((): string | null => null));
    if (raw === null) continue;
    const manifest = parseBuddyManifest(raw);
    if (manifest === null) {
      yield* Effect.logWarning("ignoring unusable buddy manifest", { path: manifestPath });
      continue;
    }
    manifests.push(manifest);
  }
  return manifests;
});

const ensureCheckout = Effect.fn("buddySources.ensureCheckout")(function* (
  repositoryUrl: string,
  refresh: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositories = yield* SourceControlRepositoryService;
  const destination = yield* checkoutDir(repositoryUrl);
  const present = yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => false));
  if (present && !refresh) return destination;

  if (!present) {
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    // Cloning goes through the configured provider, so existing credentials apply.
    yield* repositories.cloneRepository({
      remoteUrl: repositoryUrl,
      destinationPath: destination,
    });
    return destination;
  }

  // Refresh beside the live copy: a failed clone must not leave the source empty.
  const staging = `${destination}.incoming`;
  yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* repositories.cloneRepository({ remoteUrl: repositoryUrl, destinationPath: staging });
  yield* repositories.discardClone(destination);
  yield* fs.rename(staging, destination);
  return destination;
});

/** Clones each source that is missing, then reads every buddy it publishes. */
export const buddyCatalogEntries = Effect.fn("buddySources.catalog")(function* (
  repositoryUrls: ReadonlyArray<string>,
  options?: { readonly refresh?: boolean },
) {
  const entries: Array<BuddySourceCatalogEntry> = [];
  const lock = yield* syncSemaphore;
  // Sequential keeps clone progress and disk use predictable on first run.
  for (const repositoryUrl of repositoryUrls) {
    const settled = yield* ensureCheckout(repositoryUrl, options?.refresh ?? false).pipe(
      Effect.flatMap(readManifests),
      Effect.map((buddies): BuddySourceCatalogEntry => ({ repositoryUrl, buddies, error: null })),
      Effect.catch((error) =>
        Effect.logWarning("buddy source unavailable", { repositoryUrl, cause: error }).pipe(
          Effect.as<BuddySourceCatalogEntry>({
            repositoryUrl,
            buddies: [],
            error: `Could not read ${repositoryUrl}.`,
          }),
        ),
      ),
      lock.withPermits(1),
    );
    entries.push(settled);
  }
  return entries;
});

/** Resolves one clip, or null when it is not a clip this source ships. */
export const buddyClipPath = Effect.fn("buddySources.clipPath")(function* (input: {
  readonly repositoryUrl: string;
  readonly buddyId: string;
  readonly file: string;
}) {
  if (!isPlainSegment(input.buddyId) || !isPlainSegment(input.file)) return null;
  if (!input.file.endsWith(CLIP_SUFFIX)) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* checkoutDir(input.repositoryUrl);
  if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) return null;
  const filePath = path.join(directory, input.buddyId, input.file);
  const present = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  return present ? filePath : null;
});
