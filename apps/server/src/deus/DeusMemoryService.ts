// @effect-diagnostics nodeBuiltinImport:off -- lstat, opendir and O_NOFOLLOW are missing from Effect's filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  DeusSessionRef,
  DeusSourceRef,
  DeusObservationId,
  DeusStateError,
  EnvironmentId,
  ProjectId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Repository from "./DeusRepository.ts";
import { CONTEXT_LIMITS, lexicalScore, page, preview } from "./contextBounds.ts";

const EntryId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,79}$/));
export const MemoryScope = Schema.Literals(["project", "environment", "global"]);
export type MemoryScope = typeof MemoryScope.Type;
export const MemoryMetadata = Schema.Struct({
  id: EntryId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: MemoryScope,
  environmentId: Schema.NullOr(EnvironmentId),
  projectId: Schema.NullOr(ProjectId),
  updatedAt: IsoDateTime,
  observationIds: Schema.Array(DeusObservationId).check(Schema.isMaxLength(64)),
  sources: Schema.Array(DeusSourceRef).check(Schema.isMaxLength(64)),
  supersedes: Schema.NullOr(EntryId),
});
export type MemoryEntry = typeof MemoryMetadata.Type & {
  readonly text: string;
  readonly commit: string;
};
const SearchInput = Schema.Struct({
  ...DeusSessionRef.fields,
  query: Schema.String.check(Schema.isMaxLength(1024)),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CONTEXT_LIMITS.items })),
  ),
  scopes: Schema.optional(Schema.Array(MemoryScope).check(Schema.isMaxLength(3))),
});
export type MemorySearchInput = typeof SearchInput.Type;
const ReadInput = Schema.Struct({
  ...DeusSessionRef.fields,
  scope: MemoryScope,
  id: EntryId,
  revision: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type MemoryReadInput = typeof ReadInput.Type;
export type MemoryPreview = Pick<
  MemoryEntry,
  "id" | "scope" | "revision" | "commit" | "supersedes" | "observationIds"
> &
  ReturnType<typeof preview>;
export type MemoryPage = { readonly items: ReadonlyArray<MemoryPreview>; readonly omitted: number };
type Failure = Repository.DeusRepositoryError;
export class DeusMemoryService extends Context.Service<
  DeusMemoryService,
  {
    readonly search: (
      input: MemorySearchInput,
      excludedObservationIds?: ReadonlySet<DeusObservationId>,
    ) => Effect.Effect<MemoryPage, Failure>;
    readonly briefing: (ref: DeusSessionRef) => Effect.Effect<MemoryPage, Failure>;
    readonly read: (input: MemoryReadInput) => Effect.Effect<MemoryEntry, Failure>;
  }
>()("t3/deus/DeusMemoryService") {}

const invalid = () =>
  new DeusStateError({
    reason: "conflict",
    message: "Deus memory is malformed, unsafe, uncommitted, or exceeds its read bounds.",
  });
const hex = (value: string) => Buffer.from(value).toString("hex");
const entryDirectory = (ref: DeusSessionRef, scope: MemoryScope) =>
  scope === "global"
    ? "global/entries"
    : scope === "environment"
      ? `environments/${hex(ref.environmentId)}/entries`
      : `environments/${hex(ref.environmentId)}/projects/${hex(ref.projectId)}/entries`;
const safePath = async (target: string, directory: boolean) => {
  const absolute = NodePath.resolve(target);
  const parsed = NodePath.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(NodePath.sep);
  for (let index = 0; index < parts.length; index++) {
    current = NodePath.join(current, parts[index]!);
    let stat;
    try {
      stat = await NodeFSP.lstat(current);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())
    )
      throw invalid();
  }
  return true;
};
const readFile = async (file: string) => {
  if (!(await safePath(file, false)))
    throw new DeusStateError({ reason: "not-found", message: "Deus memory entry was not found." });
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CONTEXT_LIMITS.memoryFileBytes) throw invalid();
    const bytes = Buffer.alloc(CONTEXT_LIMITS.memoryFileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > CONTEXT_LIMITS.memoryFileBytes) throw invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
};
const isStateError = Schema.is(DeusStateError);
const isEntryId = Schema.is(EntryId);
const decodeRead = Schema.decodeEffect(ReadInput);
const decodeSearch = Schema.decodeEffect(SearchInput);
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (isStateError(error) ? error : invalid()),
  });
const decodeMetadata = Schema.decodeEffect(Schema.fromJsonString(MemoryMetadata));
const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const repository = yield* Repository.DeusRepository;
  const git = yield* Git.GitVcsDriver;
  const root = NodePath.join(config.stateDir, "deus-memory");
  const execute = Effect.fn("DeusMemoryService.gitRead")(function* (args: ReadonlyArray<string>) {
    const result = yield* git
      .execute({
        cwd: root,
        args: ["--git-dir", NodePath.join(root, ".git"), "--work-tree", root, ...args],
        operation: "deus-memory-read",
        maxOutputBytes: CONTEXT_LIMITS.memoryFileBytes + 1,
        env: {
          GIT_COMMON_DIR: NodePath.join(root, ".git"),
          GIT_OBJECT_DIRECTORY: NodePath.join(root, ".git", "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      })
      .pipe(Effect.mapError(() => invalid()));
    if (result.stdoutTruncated || result.stderrTruncated) return yield* invalid();
    return result.stdout;
  });
  const head = Effect.fn("DeusMemoryService.head")(function* () {
    if (!(yield* io(() => safePath(root, true)))) return null;
    if (!(yield* io(() => safePath(NodePath.join(root, ".git"), true)))) return yield* invalid();
    if (!(yield* io(() => safePath(NodePath.join(root, ".git", "objects"), true))))
      return yield* invalid();
    const commit = (yield* execute(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) return yield* invalid();
    return commit;
  });
  const load = Effect.fn("DeusMemoryService.load")(function* (
    ref: DeusSessionRef,
    scope: MemoryScope,
    id: string,
    commit: string,
  ) {
    const relative = `${entryDirectory(ref, scope)}/${id}.md`;
    const text = yield* io(() => readFile(NodePath.join(root, relative)));
    const committed = yield* execute(["show", `${commit}:${relative}`]);
    if (text !== committed) return yield* invalid();
    const match = /^<!-- deus-memory:v1 ([^\r\n]+) -->\n\n([\s\S]+)$/.exec(text);
    if (!match || !match[2]!.trim()) return yield* invalid();
    const metadata = yield* decodeMetadata(match[1]!).pipe(Effect.mapError(() => invalid()));
    if (
      metadata.id !== id ||
      metadata.scope !== scope ||
      metadata.environmentId !== (scope === "global" ? null : ref.environmentId) ||
      metadata.projectId !== (scope === "project" ? ref.projectId : null) ||
      metadata.sources.some(
        (source) =>
          scope !== "global" &&
          (source.environmentId !== ref.environmentId ||
            (scope === "project" && source.projectId !== ref.projectId)),
      )
    )
      return yield* invalid();
    return { ...metadata, text: match[2]!, commit } satisfies MemoryEntry;
  });
  const read = Effect.fn("DeusMemoryService.read")(function* (raw: MemoryReadInput) {
    const input = yield* decodeRead(raw).pipe(Effect.mapError(() => invalid()));
    yield* repository.snapshot(input);
    const commit = yield* head();
    if (!commit)
      return yield* new DeusStateError({
        reason: "not-found",
        message: "Deus memory repository was not found.",
      });
    const entry = yield* load(input, input.scope, input.id, commit);
    if (input.revision !== undefined && input.revision !== entry.revision)
      return yield* new DeusStateError({
        reason: "conflict",
        message: "Deus memory revision has changed.",
      });
    return entry;
  });
  const search = Effect.fn("DeusMemoryService.search")(function* (
    raw: MemorySearchInput,
    excludedObservationIds: ReadonlySet<DeusObservationId> = new Set(),
  ) {
    const input = yield* decodeSearch(raw).pipe(Effect.mapError(() => invalid()));
    yield* repository.snapshot(input);
    const commit = yield* head();
    if (!commit) return { items: [], omitted: 0 };
    const entries: MemoryEntry[] = [];
    let files = 0;
    for (const scope of new Set(input.scopes ?? (["project"] as const))) {
      const directory = NodePath.join(root, entryDirectory(input, scope));
      const ids = yield* io(async () => {
        if (!(await safePath(directory, true))) return [];
        const result: string[] = [];
        const dir = await NodeFSP.opendir(directory);
        for await (const file of dir) {
          files++;
          if (files > CONTEXT_LIMITS.memoryFiles || !file.isFile() || !file.name.endsWith(".md"))
            throw invalid();
          const id = file.name.slice(0, -3);
          if (!isEntryId(id)) throw invalid();
          result.push(id);
        }
        return result.sort();
      });
      for (const id of ids) entries.push(yield* load(input, scope, id, commit));
    }
    const superseded = new Set(
      entries.map((entry) =>
        entry.supersedes === null ? "" : `${entry.scope}:${entry.supersedes}`,
      ),
    );
    const ranked = entries
      .filter(
        (entry) =>
          !superseded.has(`${entry.scope}:${entry.id}`) &&
          !entry.observationIds.some((id) => excludedObservationIds.has(id)),
      )
      .map((entry) => ({ entry, score: lexicalScore(`${entry.id} ${entry.text}`, input.query) }))
      .filter(({ score }) => !input.query.trim() || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
          a.entry.id.localeCompare(b.entry.id),
      );
    return page(
      ranked.map(({ entry }) => ({
        id: entry.id,
        scope: entry.scope,
        revision: entry.revision,
        commit: entry.commit,
        supersedes: entry.supersedes,
        observationIds: entry.observationIds,
        ...preview(entry.text),
      })),
      input.limit,
    );
  });
  return DeusMemoryService.of({
    read,
    search,
    briefing: Effect.fn("DeusMemoryService.briefing")((ref) => search({ ...ref, query: "" })),
  });
});
export const layer = Layer.effect(DeusMemoryService, make);
