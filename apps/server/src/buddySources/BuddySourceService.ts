import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class BuddySourceError extends Schema.TaggedError<BuddySourceError>()("BuddySourceError", {
  message: Schema.String,
}) {}

/** One buddy folder on disk. */
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

export interface BuddyFolderCatalogEntry {
  readonly folderPath: string;
  readonly buddies: ReadonlyArray<BuddyManifest>;
  /** Why this folder could not be read, so one bad folder does not hide the rest. */
  readonly error: string | null;
}

interface ScannedBuddy {
  readonly manifest: BuddyManifest;
  readonly directory: string;
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

const isPlainSegment = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("\0");

const isInsideDirectory = (parent: string, target: string, sep: string): boolean => {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return target.startsWith(prefix);
};

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

const resolveConfiguredFolder = Effect.fn("buddySources.resolveFolder")(function* (
  folderPath: string,
) {
  const trimmed = folderPath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) {
    return yield* new BuddySourceError({ message: "Folder path is empty or invalid." });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const expanded = path.resolve(expandHomePath(trimmed, homeDirectory));
  const realFolder = yield* realPathOrNull(expanded);
  if (realFolder === null) {
    return yield* new BuddySourceError({ message: `Folder not found: ${folderPath}` });
  }
  const info = yield* fs.stat(realFolder).pipe(Effect.orElseSucceed(() => null));
  if (info?.type !== "Directory") {
    return yield* new BuddySourceError({ message: `Path is not a folder: ${folderPath}` });
  }
  return realFolder;
});

const readManifestAt = Effect.fnUntraced(function* (realFolder: string, candidateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(candidateDir, MANIFEST_FILE);
  const realManifestPath = yield* realPathOrNull(manifestPath);
  if (realManifestPath === null) return null;
  if (!isInsideDirectory(realFolder, realManifestPath, path.sep)) {
    yield* Effect.logWarning("ignoring buddy manifest outside its configured folder", {
      path: manifestPath,
    });
    return null;
  }
  const realBuddyDir = path.dirname(realManifestPath);
  if (realBuddyDir !== realFolder && !isInsideDirectory(realFolder, realBuddyDir, path.sep)) {
    return null;
  }
  const raw = yield* fs
    .readFileString(realManifestPath)
    .pipe(Effect.orElseSucceed((): string | null => null));
  if (raw === null) return null;
  const manifest = parseBuddyManifest(raw);
  if (manifest === null) {
    yield* Effect.logWarning("ignoring unusable buddy manifest", { path: manifestPath });
    return null;
  }
  return { manifest, directory: realBuddyDir } satisfies ScannedBuddy;
});

/**
 * Scans a configured folder for buddies. Supports both a single buddy folder containing
 * `buddy.json` directly and a collection folder containing one subfolder per buddy.
 */
const scanBuddyFolder = Effect.fn("buddySources.scanFolder")(function* (folderPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realFolder = yield* resolveConfiguredFolder(folderPath);
  const discovered: Array<ScannedBuddy> = [];
  const seenIds = new Set<string>();

  const addIfUnique = (entry: ScannedBuddy | null) => {
    if (entry === null || seenIds.has(entry.manifest.id)) return;
    seenIds.add(entry.manifest.id);
    discovered.push(entry);
  };

  addIfUnique(yield* readManifestAt(realFolder, realFolder));

  const entries = yield* fs
    .readDirectory(realFolder)
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  for (const entry of entries.toSorted()) {
    if (!isPlainSegment(entry)) continue;
    addIfUnique(yield* readManifestAt(realFolder, path.join(realFolder, entry)));
  }

  return { realFolder, buddies: discovered };
});

/** Reads every configured buddy folder from disk without mutating anything. */
export const buddyCatalogEntries = Effect.fn("buddySources.catalog")(function* (
  folderPaths: ReadonlyArray<string>,
) {
  const entries: Array<BuddyFolderCatalogEntry> = [];
  for (const folderPath of folderPaths) {
    const settled = yield* scanBuddyFolder(folderPath).pipe(
      Effect.map(({ buddies }): BuddyFolderCatalogEntry => ({
        folderPath,
        buddies: buddies.map((entry) => entry.manifest),
        error: null,
      })),
      Effect.catch((error) =>
        Effect.logWarning("buddy folder unavailable", { folderPath, cause: error }).pipe(
          Effect.as<BuddyFolderCatalogEntry>({
            folderPath,
            buddies: [],
            error: error.message,
          }),
        ),
      ),
    );
    entries.push(settled);
  }
  return entries;
});

/**
 * Resolves one declared clip from a configured buddy folder, or null when the folder is not
 * configured, the buddy/clip is not declared in its manifest, or a symlink escapes the folder.
 */
export const buddyClipPath = Effect.fn("buddySources.clipPath")(function* (input: {
  readonly configuredFolders: ReadonlyArray<string>;
  readonly folderPath: string;
  readonly buddyId: string;
  readonly file: string;
}) {
  if (!input.configuredFolders.includes(input.folderPath)) return null;
  if (!isPlainSegment(input.buddyId) || !isPlainSegment(input.file)) return null;
  if (!input.file.endsWith(CLIP_SUFFIX)) return null;
  const path = yield* Path.Path;
  const scanned = yield* scanBuddyFolder(input.folderPath).pipe(Effect.orElseSucceed(() => null));
  if (scanned === null) return null;
  const match = scanned.buddies.find((entry) => entry.manifest.id === input.buddyId);
  if (match === undefined) return null;
  if (!Object.values(match.manifest.clips).includes(input.file)) return null;
  const filePath = path.join(match.directory, input.file);
  const realFilePath = yield* realPathOrNull(filePath);
  if (realFilePath === null) return null;
  return isInsideDirectory(match.directory, realFilePath, path.sep) &&
    isInsideDirectory(scanned.realFolder, realFilePath, path.sep)
    ? realFilePath
    : null;
});
