// @effect-diagnostics nodeBuiltinImport:off -- Exclusive no-follow writes protect the server-owned memory repository.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { DeusMemoryCorrectionInput, DeusMemoryId, type DeusMemory } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Repository from "./DeusRepository.ts";
import { MemoryMetadata, entryDirectory, safePath } from "./DeusMemoryService.ts";
import { ponderError, type PonderRun } from "./ponderProtocol.ts";

export class DeusMemoryWriter extends Context.Service<
  DeusMemoryWriter,
  {
    readonly correct: <E>(
      input: DeusMemoryCorrectionInput,
      authorize: Effect.Effect<void, E>,
    ) => Effect.Effect<DeusMemory, E | Repository.DeusRepositoryError>;
    readonly commit: (
      run: PonderRun,
    ) => Effect.Effect<
      { readonly commit: string | null; readonly ids: ReadonlyArray<DeusMemoryId> },
      ReturnType<typeof ponderError>
    >;
  }
>()("t3/deus/DeusMemoryWriter") {}
const decodeCorrection = Schema.decodeEffect(DeusMemoryCorrectionInput);
const decodeMetadata = Schema.decodeEffect(Schema.fromJsonString(MemoryMetadata));
const encodeMetadata = Schema.encodeSync(Schema.fromJsonString(MemoryMetadata));
const encodeCorrection = Schema.encodeSync(Schema.fromJsonString(DeusMemoryCorrectionInput));
const encodeCorrectionIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const git = yield* Git.GitVcsDriver;
  const memory = yield* Memory.DeusMemoryService;
  const repository = yield* Repository.DeusRepository;
  const lane = yield* Semaphore.make(1);
  const root = NodePath.join(config.stateDir, "deus-memory");
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        ponderError("Learning memory filesystem operation failed; retry the persisted intent."),
    });
  const execute = Effect.fn("DeusMemoryWriter.git")(function* (
    args: ReadonlyArray<string>,
    allowFailure = false,
  ) {
    const result = yield* git
      .execute({
        cwd: root,
        args: [
          "--git-dir",
          NodePath.join(root, ".git"),
          "--work-tree",
          root,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Deus",
          "-c",
          "user.email=deus@localhost",
          ...args,
        ],
        operation: "deus-memory-promote",
        maxOutputBytes: 64_000,
        allowNonZeroExit: allowFailure,
        env: {
          GIT_COMMON_DIR: NodePath.join(root, ".git"),
          GIT_OBJECT_DIRECTORY: NodePath.join(root, ".git", "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      .pipe(
        Effect.mapError(() =>
          ponderError("Learning Git operation failed; retry the persisted intent."),
        ),
      );
    if (
      (!allowFailure && result.exitCode !== 0) ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      return yield* ponderError("Learning Git commit failed; no records were acknowledged.");
    return result;
  });
  const commit = Effect.fn("DeusMemoryWriter.commit")(function* (run: PonderRun) {
    if (!run.intent) return yield* ponderError("Learning promotion has no persisted intent.");
    if (run.intent.entries.length === 0) return { commit: null, ids: [] };
    const entries = run.intent.entries.map((entry, index) => {
      const id = DeusMemoryId.make(`${run.receipt.id}-${index}`);
      const observations = [...new Set(entry.evidence.map((item) => item.observationId))];
      const metadata = {
        id,
        revision: 1,
        scope: entry.scope,
        environmentId: run.environmentId,
        projectId: run.projectId,
        updatedAt: run.receipt.createdAt,
        observationIds: observations,
        sources: observations.map(
          (observationId) => run.observations.find((item) => item.id === observationId)!.source!,
        ),
        supersedes: null,
        kind: entry.kind,
        paths: entry.paths,
        evidence: entry.evidence,
      } satisfies typeof MemoryMetadata.Type;
      const header = encodeMetadata(metadata);
      return {
        id,
        path: `${entryDirectory(run, "project")}/${id}.md`,
        content: `<!-- deus-memory:v1 ${header} -->\n\n${entry.text}\n`,
      };
    });
    yield* io(async () => {
      await safePath(root, true);
      await NodeFSP.mkdir(root, { recursive: true });
      if (!(await safePath(root, true))) throw ponderError("Unsafe learning repository.");
    });
    if (!(yield* io(() => safePath(NodePath.join(root, ".git"), true))))
      yield* execute(["init", "--quiet"]);
    if (!(yield* io(() => safePath(NodePath.join(root, ".git", "objects"), true))))
      return yield* ponderError("Unsafe learning Git objects directory.");
    const marker = `Deus-Ponder: ${run.receipt.id}`;
    const head = yield* execute(["rev-parse", "--verify", "HEAD"], true);
    if (head.exitCode === 0) {
      const existing = (yield* execute([
        "log",
        "--format=%H",
        "--fixed-strings",
        `--grep=${marker}`,
        "-1",
      ])).stdout.trim();
      if (existing) {
        for (const entry of entries) {
          const stored = yield* execute(["show", `${existing}:${entry.path}`]);
          if (stored.stdout !== entry.content)
            return yield* ponderError("Learning commit differs from its persisted intent.");
        }
        return { commit: existing, ids: entries.map((entry) => entry.id) };
      }
    }
    const allowed = new Set(entries.map((entry) => entry.path));
    const status = (yield* execute(["status", "--porcelain", "--untracked-files=all"])).stdout;
    if (
      status
        .split("\n")
        .filter(Boolean)
        .some((line) => !allowed.has(line.slice(3)))
    )
      return yield* ponderError("Learning memory repository contains unrelated changes.");
    for (const entry of entries) {
      yield* io(async () => {
        const target = NodePath.join(root, entry.path);
        await safePath(NodePath.dirname(target), true);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await safePath(NodePath.dirname(target), true);
        if (await safePath(target, false)) {
          const handle = await NodeFSP.open(
            target,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
          );
          try {
            if (
              (await handle.stat()).size !== Buffer.byteLength(entry.content) ||
              (await handle.readFile("utf8")) !== entry.content
            )
              throw ponderError("Learning retry found a different memory file.");
          } finally {
            await handle.close();
          }
        } else {
          const handle = await NodeFSP.open(
            target,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              NodeFS.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await handle.writeFile(entry.content);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      });
    }
    const paths = entries.map((entry) => entry.path);
    yield* execute(["add", "--", ...paths]);
    yield* execute([
      "commit",
      "--quiet",
      "--only",
      "-m",
      `Promote Deus learning\n\n${marker}`,
      "--",
      ...paths,
    ]);
    const result = (yield* execute(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(result))
      return yield* ponderError("Learning commit receipt is invalid.");
    return { commit: result, ids: entries.map((entry) => entry.id) };
  }, lane.withPermits(1));
  const correct: DeusMemoryWriter["Service"]["correct"] = Effect.fn("DeusMemoryWriter.correct")(
    function* (raw, authorize) {
      const input = yield* decodeCorrection(raw).pipe(
        Effect.mapError(() => ponderError("Invalid human memory correction.")),
      );
      yield* authorize;
      yield* repository.snapshot(input);
      const id = DeusMemoryId.make(
        `correction-${NodeCrypto.createHash("sha256")
          .update(
            encodeCorrectionIdentity([
              input.environmentId,
              input.projectId,
              input.sessionId,
              input.inputId,
            ]),
          )
          .digest("hex")
          .slice(0, 40)}`,
      );
      const relative = `${entryDirectory(input, "project")}/${id}.md`;
      const target = NodePath.join(root, relative);
      const fingerprint = encodeCorrection(input);
      let entry: Memory.MemoryEntry;
      const exists = yield* io(() => safePath(target, false));
      if (exists) {
        const content = yield* io(() => NodeFSP.readFile(target, "utf8"));
        const match = /^<!-- deus-memory:v1 ([^\r\n]+) -->\n\n([\s\S]+)$/.exec(content);
        if (!match) return yield* ponderError("Invalid persisted correction.");
        const metadata = yield* decodeMetadata(match[1]!).pipe(
          Effect.mapError(() => ponderError("Invalid persisted correction.")),
        );
        if (metadata.correctionInputId !== fingerprint)
          return yield* ponderError("Correction identity was reused with different input.");
        const stored = yield* execute(["show", `HEAD:${relative}`], true);
        if (stored.exitCode !== 0 || stored.stdout !== content) {
          yield* authorize;
          yield* execute(["add", "--", relative]);
          yield* execute([
            "commit",
            "--quiet",
            "--only",
            "-m",
            `Correct Deus memory\n\nDeus-Correction: ${id}`,
            "--",
            relative,
          ]);
        }
        entry = {
          ...metadata,
          text: match[2]!,
          commit: (yield* execute(["log", "-1", "--format=%H", "--", relative])).stdout.trim(),
        };
      } else {
        const previous = yield* memory.read({
          ...input,
          id: input.memoryId,
          scope: "project",
          revision: input.expectedRevision,
        });
        const status = (yield* execute(["status", "--porcelain", "--untracked-files=all"])).stdout;
        if (status.trim()) return yield* ponderError("Memory contains unrelated changes.");
        const now = DateTime.formatIso(yield* DateTime.now);
        const metadata = {
          ...previous,
          id,
          revision: previous.revision + 1,
          supersedes: previous.id,
          updatedAt: now,
          removedAt: input.correction === null ? now : null,
          correctionInputId: fingerprint,
        };
        const text = input.correction ?? "Removed by explicit human correction.";
        const content = `<!-- deus-memory:v1 ${encodeMetadata(metadata)} -->\n\n${text}\n`;
        yield* authorize;
        yield* io(async () => {
          await safePath(NodePath.dirname(target), true);
          const handle = await NodeFSP.open(
            target,
            NodeFS.constants.O_WRONLY |
              NodeFS.constants.O_CREAT |
              NodeFS.constants.O_EXCL |
              NodeFS.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await handle.writeFile(content);
            await handle.sync();
          } finally {
            await handle.close();
          }
        });
        yield* execute(["add", "--", relative]);
        yield* execute([
          "commit",
          "--quiet",
          "--only",
          "-m",
          `Correct Deus memory\n\nDeus-Correction: ${id}`,
          "--",
          relative,
        ]);
        entry = {
          ...metadata,
          text: `${text}\n`,
          commit: (yield* execute(["rev-parse", "HEAD"])).stdout.trim(),
        };
      }
      const result: DeusMemory = {
        id,
        revision: entry.revision,
        text: entry.text,
        observationIds: entry.observationIds,
        ponderId: null,
        supersedes: DeusMemoryId.make(input.memoryId),
        removedAt: entry.removedAt ?? null,
        updatedAt: entry.updatedAt,
        provenance: { scope: "project", sources: entry.sources, commit: entry.commit },
      };
      yield* authorize;
      yield* repository.commit({ type: "correct-memory", input: { ...input, memory: result } });
      return result;
    },
    lane.withPermits(1),
  );
  return DeusMemoryWriter.of({ commit, correct });
});
export const layer = Layer.effect(DeusMemoryWriter, make);
