import { TrimmedNonEmptyString } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest inside the pure source slug.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";

class BuddySourceError extends Schema.TaggedError<BuddySourceError>()("BuddySourceError", {
  message: Schema.String,
}) {}

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

const MANIFEST_FILE = "buddy.json";
const CLIP_SUFFIX = ".webm";
const SOURCE_SLUG_PREFIX_LIMIT = 40;

const SAFE_HOST = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/;

const isSafeHost = (host: string): boolean =>
  host.length > 0 &&
  !host.includes("..") &&
  (SAFE_HOST.test(host) || /^\[[0-9a-fA-F:.]+\]$/.test(host));

const isSafeRepositoryPath = (value: string): boolean => {
  const segments = value.replace(/^\/+/, "").split("/");
  if (segments.some((segment) => segment === ".." || segment.includes("\\"))) return false;
  return segments.some((segment) => segment.length > 0 && segment !== ".");
};

/**
 * Only remote URLs the clone provider understands may name a checkout directory.
 * Options, local paths, and traversal fragments are rejected before any filesystem use.
 */
export const isSupportedRepositoryUrl = (repositoryUrl: string): boolean => {
  if (repositoryUrl.length === 0 || repositoryUrl.length > 2048) return false;
  if (repositoryUrl.startsWith("-")) return false;
  if (/[\s\p{Cc}]/u.test(repositoryUrl)) return false;
  if (/^file:/i.test(repositoryUrl)) return false;
  if (/(?:^|[/:])\.\.(?:$|[/:])/.test(repositoryUrl)) return false;

  const scpLike = SCP_LIKE_URL.exec(repositoryUrl);
  if (scpLike !== null) {
    return isSafeHost(scpLike[1]!) && isSafeRepositoryPath(scpLike[2]!);
  }

  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
    return false;
  }
  return isSafeHost(parsed.hostname) && isSafeRepositoryPath(parsed.pathname);
};

/**
 * A readable, collision-free directory name. The hash suffix keeps the result non-empty and
 * never `.` or `..`, even for a URL whose readable part sanitizes away to nothing.
 */
export const sourceSlug = (repositoryUrl: string): string => {
  const readable = repositoryUrl
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/\.git$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, SOURCE_SLUG_PREFIX_LIMIT)
    .replace(/[.-]+$/g, "");
  const digest = NodeCrypto.createHash("sha256").update(repositoryUrl).digest("hex").slice(0, 12);
  return `${readable.length === 0 ? "source" : readable}-${digest}`;
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

const realPathOrNull = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(target).pipe(Effect.orElseSucceed((): string | null => null));
});

const checkoutDir = Effect.fn("buddySources.checkoutDir")(function* (repositoryUrl: string) {
  if (!isSupportedRepositoryUrl(repositoryUrl)) return null;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const root = path.resolve(config.baseDir, "userdata", "buddy-sources");
  const destination = path.resolve(root, sourceSlug(repositoryUrl));
  return destination.startsWith(`${root}${path.sep}`) ? destination : null;
});

const readManifests = Effect.fn("buddySources.readManifests")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realDirectory = yield* realPathOrNull(directory);
  if (realDirectory === null) return [];
  const entries = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const manifests: Array<BuddyManifest> = [];
  for (const entry of entries.toSorted()) {
    if (!isPlainSegment(entry)) continue;
    const manifestPath = path.join(directory, entry, MANIFEST_FILE);
    const realManifestPath = yield* realPathOrNull(manifestPath);
    if (realManifestPath === null) continue;
    if (!realManifestPath.startsWith(`${realDirectory}${path.sep}`)) {
      yield* Effect.logWarning("ignoring buddy manifest outside its source checkout", {
        path: manifestPath,
      });
      continue;
    }
    const raw = yield* fs
      .readFileString(realManifestPath)
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

const readPresentCheckout = Effect.fn("buddySources.presentCheckout")(function* (
  repositoryUrl: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const destination = yield* checkoutDir(repositoryUrl);
  const present =
    destination !== null && (yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => false)));
  if (destination === null || !present) {
    return yield* new BuddySourceError({ message: "Buddy source is not downloaded." });
  }
  return destination;
});

const ensureCheckout = Effect.fn("buddySources.ensureCheckout")(function* (
  repositoryUrl: string,
  refresh: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositories = yield* SourceControlRepositoryService;
  const destination = yield* checkoutDir(repositoryUrl);
  if (destination === null) {
    return yield* new BuddySourceError({ message: "Unsupported buddy source URL." });
  }
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

export interface BuddyCatalogOptions {
  /** Clone missing sources and re-clone present ones. Read-only callers leave this off. */
  readonly sync?: boolean;
  readonly refresh?: boolean;
  /** Shared across requests by the route layer; a fresh one is fine for one-off calls. */
  readonly lock?: Semaphore.Semaphore;
}

/**
 * Reads each configured source. `sync` runs the clone provider first; without it this only
 * reads checkouts that already exist, so a GET never writes to the filesystem.
 */
export const buddyCatalogEntries = Effect.fn("buddySources.catalog")(function* (
  repositoryUrls: ReadonlyArray<string>,
  options?: BuddyCatalogOptions,
) {
  const entries: Array<BuddySourceCatalogEntry> = [];
  if (repositoryUrls.length === 0) return entries;
  const lock = options?.lock ?? (yield* Semaphore.make(1));
  // Sequential keeps clone progress and disk use predictable on first run.
  for (const repositoryUrl of repositoryUrls) {
    const load = options?.sync
      ? ensureCheckout(repositoryUrl, options.refresh ?? false)
      : readPresentCheckout(repositoryUrl);
    const settled = yield* load.pipe(
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
  const path = yield* Path.Path;
  const directory = yield* checkoutDir(input.repositoryUrl);
  if (directory === null) return null;
  // A cloned repository can contain symlinks; only real paths inside the checkout are served.
  const realDirectory = yield* realPathOrNull(directory);
  if (realDirectory === null) return null;
  const filePath = path.join(directory, input.buddyId, input.file);
  const realFilePath = yield* realPathOrNull(filePath);
  if (realFilePath === null) return null;
  return realFilePath.startsWith(`${realDirectory}${path.sep}`) ? realFilePath : null;
});
