// @effect-diagnostics nodeBuiltinImport:off -- This Promise adapter owns byte-bounded Git subprocesses and disposable temporary indexes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { MACHINE_HANDOFF_MAX_BYTES, type MachineHandoffGitSnapshot } from "@t3tools/contracts";

const { spawn } = NodeChildProcess;
const { createHash, randomUUID } = NodeCrypto;
const { chmod, lstat, mkdir, mkdtempDisposable, readFile, writeFile } = NodeFSP;
const { tmpdir } = NodeOS;
const { dirname, join, resolve } = NodePath;

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
};
async function git(cwd: string, args: string[], env = gitEnv) {
  return (
    await exec("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      maxBuffer: MACHINE_HANDOFF_MAX_BYTES,
      timeout: 60_000,
    })
  ).stdout.trimEnd();
}
async function gitInput(cwd: string, args: string[], input: string, env = gitEnv): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MACHINE_HANDOFF_MAX_BYTES) {
        child.kill();
        reject(new Error("Machine handoff metadata exceeds byte limit"));
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure.length < 4096) failure += chunk.toString();
    });
    child.on("close", (code) =>
      code === 0
        ? accept(Buffer.concat(chunks).toString("utf8"))
        : reject(new Error(`Machine handoff Git operation failed: ${failure}`)),
    );
    child.stdin.end(input);
  });
}
function safePath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part === "." ||
          part.toLowerCase().replace(/[. ]+$/, "") === ".git" ||
          part.includes(":"),
      )
  ) {
    throw new Error("Unsafe machine handoff path");
  }
  return path;
}
async function tree(cwd: string, revision: string) {
  const rows = (await git(cwd, ["ls-tree", "-rz", revision])).split("\0").filter(Boolean);
  if (rows.length > MAX_FILES) throw new Error("Machine handoff has too many files");
  return rows.map((row) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(row);
    if (!match)
      throw new Error("Machine handoff refuses submodules, symlinks, and special file types");
    return { mode: match[1]!, oid: match[2]!, path: safePath(match[3]!) };
  });
}
async function bundle(cwd: string, ref: string): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = spawn("git", ["-C", cwd, "bundle", "create", "-", ref, "--not", "--remotes"], {
      env: gitEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    const parts: Buffer[] = [];
    let bytes = 0;
    let failure = "";
    child.stdout.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > MAX_BUNDLE_BYTES) {
        child.kill();
        reject(new Error("Machine handoff exceeds bundle byte limit"));
      } else parts.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      if (failure.length < 4096) failure += part.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? accept(Buffer.concat(parts))
        : reject(new Error(`Machine handoff bundle failed: ${failure}`)),
    );
  });
}
async function assertChangedBytes(
  cwd: string,
  head: string,
  indexTree: string,
  worktreeTree: string,
) {
  const unchanged = new Set((await tree(cwd, head)).map((file) => file.oid));
  const changed = new Set(
    (await tree(cwd, indexTree))
      .concat(await tree(cwd, worktreeTree))
      .map((file) => file.oid)
      .filter((oid) => !unchanged.has(oid)),
  );
  let bytes = 0;
  for (const oid of changed) {
    bytes += Number(await git(cwd, ["cat-file", "-s", oid]));
    if (!Number.isSafeInteger(bytes) || bytes > MAX_FILE_BYTES)
      throw new Error("Machine handoff exceeds expanded changed-file byte limit");
  }
}

async function materialize(cwd: string, target: string, files: Awaited<ReturnType<typeof tree>>) {
  const child = spawn("git", ["-C", cwd, "cat-file", "--batch"], {
    env: gitEnv,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  let failure: Error | undefined;
  const completion = new Promise<number | null>((accept) => {
    child.on("error", (cause) => {
      failure = cause;
      accept(null);
    });
    child.on("close", accept);
  });
  child.stdin.on("error", (cause) => {
    failure = cause;
  });
  child.stderr.resume();
  const output = child.stdout[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const read = async (size: number): Promise<Buffer> => {
    if (buffered.length === 0) {
      const next = await output.next();
      if (next.done) throw failure ?? new Error("Incomplete machine handoff object stream");
      buffered = Buffer.from(next.value as Uint8Array);
    }
    const chunk = buffered.subarray(0, Math.min(size, buffered.length));
    buffered = buffered.subarray(chunk.length);
    return chunk;
  };
  try {
    for (const file of files) {
      child.stdin.write(`${file.oid}\n`);
      let header = "";
      while (!header.endsWith("\n")) {
        header += (await read(1)).toString("ascii");
        if (header.length > 128) throw new Error("Invalid machine handoff object header");
      }
      const match = /^([a-f0-9]{40}) blob (\d+)\n$/.exec(header);
      if (!match || match[1] !== file.oid) throw new Error("Invalid machine handoff object type");
      let remaining = Number(match[2]);
      if (!Number.isSafeInteger(remaining)) throw new Error("Invalid machine handoff object size");
      const absolute = join(target, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      const handle = await NodeFSP.open(absolute, "wx", file.mode === "100755" ? 0o755 : 0o644);
      try {
        while (remaining > 0) {
          const chunk = await read(Math.min(remaining, 64 * 1024));
          await handle.writeFile(chunk);
          remaining -= chunk.length;
        }
      } finally {
        await handle.close();
      }
      if ((await read(1)).toString() !== "\n")
        throw new Error("Invalid machine handoff object framing");
      await chmod(absolute, file.mode === "100755" ? 0o755 : 0o644);
    }
    child.stdin.end();
    if ((await completion) !== 0)
      throw failure ?? new Error("Machine handoff object stream failed");
  } finally {
    child.kill();
    await completion;
  }
}

async function fingerprint(cwd: string) {
  const hash = createHash("sha256");
  hash.update(await git(cwd, ["rev-parse", "HEAD"]));
  hash.update(
    await readFile(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])),
  );
  const dirty = await git(cwd, [
    "-c",
    "core.filemode=true",
    "-c",
    "core.fsmonitor=false",
    "diff-files",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
  ]);
  const untracked = await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const paths = [...new Set(`${dirty}\0${untracked}`.split("\0").filter(Boolean))].sort();
  if (paths.length > MAX_FILES) throw new Error("Machine handoff has too many files");
  let bytes = 0;
  const files = [];
  for (const path of paths) {
    safePath(path);
    const absolute = join(cwd, path);
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length++) {
      const parent = await lstat(join(cwd, ...segments.slice(0, length))).catch(
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return null;
          throw cause;
        },
      );
      if (parent !== null && !parent.isDirectory())
        throw new Error("Machine handoff refuses symlink or special-file ancestors");
    }
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(path);
    if (stat === null) {
      hash.update("deleted");
      files.push({ path, data: null, mode: "0" });
      continue;
    }
    if (!stat.isFile())
      throw new Error("Machine handoff refuses symlinks, submodules, and special files");
    bytes += stat.size;
    if (bytes > MAX_FILE_BYTES) throw new Error("Machine handoff exceeds working-file byte limit");
    const handle = await NodeFSP.open(absolute, "r");
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    try {
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > stat.size)
        throw new Error("Source workspace changed during machine handoff; retry when idle");
    } finally {
      await handle.close();
    }
    const data = buffer.subarray(0, length);
    const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    hash.update(mode).update(data);
    files.push({ path, data, mode });
  }
  return { digest: hash.digest("hex"), files };
}

export async function exportGitSnapshot(
  cwd: string,
  projectRoot = cwd,
): Promise<MachineHandoffGitSnapshot> {
  await using temporary = await mkdtempDisposable(join(tmpdir(), "t3-machine-export-"));
  if (
    (await git(projectRoot, ["rev-parse", "--show-prefix"])) ||
    (await git(cwd, ["rev-parse", "--show-prefix"]))
  )
    throw new Error(
      "Machine handoff currently requires a repository-root project, not a repository subdirectory",
    );
  if ((await git(cwd, ["rev-parse", "--show-object-format"])) !== "sha1")
    throw new Error("Machine handoff currently requires a SHA-1 Git repository");
  const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  if (await git(cwd, ["ls-files", "--unmerged"]))
    throw new Error("Machine handoff refuses an unmerged index");
  if ((await git(cwd, ["ls-files", "--debug"])).match(/flags: (?!0(?:\n|$))\S+/))
    throw new Error(
      "Machine handoff refuses special index flags (including sparse and intent-to-add)",
    );
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ]) {
    const path = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", marker]);
    if (await lstat(path).catch(() => null))
      throw new Error("Finish the in-progress Git operation before machine handoff");
  }
  await tree(cwd, head);
  const attributes = (
    await gitInput(
      cwd,
      ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding", "eol"],
      await git(cwd, ["ls-files", "-z"]),
    )
  ).split("\0");
  for (let index = 2; index < attributes.length; index += 3) {
    const value = attributes[index];
    if (
      value !== "unspecified" &&
      value !== "unset" &&
      !(attributes[index - 1] === "eol" && value === "lf")
    )
      throw new Error(
        "Machine handoff currently refuses Git content filters and working-tree encoding/newline conversions",
      );
  }
  const autocrlf = await git(cwd, ["config", "--get", "core.autocrlf"]).catch(() => "false");
  const configuredEol = await git(cwd, ["config", "--get", "core.eol"]).catch(() => "lf");
  if (autocrlf !== "false" || configuredEol === "crlf")
    throw new Error("Machine handoff currently refuses working-tree newline conversions");
  const before = await fingerprint(cwd);
  const index = join(temporary.path, "index");
  const env = { ...gitEnv, GIT_INDEX_FILE: index };
  await writeFile(
    index,
    await readFile(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])),
  );
  const indexTree = await git(cwd, ["write-tree"], env);
  await tree(cwd, indexTree);
  const workIndex = join(temporary.path, "work-index");
  const workEnv = { ...gitEnv, GIT_INDEX_FILE: workIndex };
  await git(cwd, ["read-tree", indexTree], workEnv);
  const input: string[] = [];
  for (const file of before.files) {
    if (file.data === null) {
      input.push(`0 ${"0".repeat(40)}\t${file.path}\0`);
      continue;
    }
    const path = join(temporary.path, "blob");
    await writeFile(path, file.data);
    const oid = await git(cwd, ["hash-object", "-w", "--no-filters", path]);
    input.push(`${file.mode} ${oid}\t${file.path}\0`);
  }
  await gitInput(cwd, ["update-index", "-z", "--index-info"], input.join(""), workEnv);
  const worktreeTree = await git(cwd, ["write-tree"], workEnv);
  await assertChangedBytes(cwd, head, indexTree, worktreeTree);
  const author = {
    ...gitEnv,
    GIT_AUTHOR_NAME: "T3 Checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@t3.codes",
    GIT_COMMITTER_NAME: "T3 Checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@t3.codes",
  };
  const indexCommit = await git(
    cwd,
    ["commit-tree", indexTree, "-p", head, "-m", "Machine handoff index"],
    author,
  );
  const commit = await git(
    cwd,
    ["commit-tree", worktreeTree, "-p", indexCommit, "-m", "Machine handoff worktree"],
    author,
  );
  const ref = `refs/t3/machine-handoff/${randomUUID()}`;
  await git(cwd, ["update-ref", ref, commit]);
  try {
    const payload = await bundle(cwd, ref);
    if ((await fingerprint(cwd)).digest !== before.digest)
      throw new Error("Source workspace changed during machine handoff; retry when idle");
    return { ref, head, indexTree, worktreeTree, bundle: payload.toString("base64") };
  } finally {
    await git(cwd, ["update-ref", "-d", ref]);
  }
}

export async function importGitSnapshot(
  cwd: string,
  target: string,
  snapshot: MachineHandoffGitSnapshot,
): Promise<void> {
  if (await lstat(target).catch(() => null))
    throw new Error(
      "Machine handoff target already exists; existing checkouts are never overwritten",
    );
  if (await git(cwd, ["rev-parse", "--show-prefix"]))
    throw new Error("Machine handoff currently requires a repository-root destination project");
  if (
    !/^refs\/t3\/machine-handoff\/[a-f0-9-]{36}$/.test(snapshot.ref) ||
    ![snapshot.head, snapshot.indexTree, snapshot.worktreeTree].every((oid) =>
      /^[a-f0-9]{40,64}$/.test(oid),
    )
  )
    throw new Error("Invalid machine handoff Git identity");
  if (
    snapshot.bundle.length > MACHINE_HANDOFF_MAX_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(snapshot.bundle)
  )
    throw new Error("Invalid machine handoff bundle encoding");
  const data = Buffer.from(snapshot.bundle, "base64");
  if (
    data.length > MAX_BUNDLE_BYTES ||
    !data.subarray(0, 16).toString().startsWith("# v2 git bundle\n")
  )
    throw new Error("Invalid or oversized machine handoff bundle");
  await using temporary = await mkdtempDisposable(join(tmpdir(), "t3-machine-import-"));
  const path = join(temporary.path, "snapshot.bundle");
  await writeFile(path, data);
  await git(cwd, ["bundle", "verify", path]).catch((cause: unknown) => {
    if (cause instanceof Error && /prerequisite|repository lacks/i.test(cause.message))
      throw new Error(
        "Destination clone is missing required source history. Clone or fetch the complete source base history before retrying this handoff.",
      );
    throw new Error("Invalid machine handoff Git bundle");
  });
  const heads = await git(cwd, ["bundle", "list-heads", path]);
  if (!new RegExp(`^[a-f0-9]{40,64} ${snapshot.ref}$`).test(heads))
    throw new Error("Unexpected machine handoff bundle refs");
  const ref = `refs/t3/machine-handoff/${randomUUID()}`;
  let added = false;
  try {
    await git(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", path, `${snapshot.ref}:${ref}`]);
    if (
      (await git(cwd, ["rev-parse", `${ref}^{tree}`])) !== snapshot.worktreeTree ||
      (await git(cwd, ["rev-parse", `${ref}^1^{tree}`])) !== snapshot.indexTree ||
      (await git(cwd, ["rev-parse", `${ref}^1^1`])) !== snapshot.head
    )
      throw new Error("Machine handoff Git trees do not match bundle");
    await tree(cwd, snapshot.head);
    await tree(cwd, snapshot.indexTree);
    const files = await tree(cwd, snapshot.worktreeTree);
    await assertChangedBytes(cwd, snapshot.head, snapshot.indexTree, snapshot.worktreeTree);
    await mkdir(dirname(target), { recursive: true });
    await git(cwd, [
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      resolve(target),
      snapshot.head,
    ]);
    added = true;
    await materialize(cwd, target, files);
    await git(target, ["read-tree", snapshot.indexTree]);
  } catch (error) {
    if (added) await git(cwd, ["worktree", "remove", "--force", resolve(target)]);
    throw error;
  } finally {
    await git(cwd, ["update-ref", "-d", ref]);
  }
}
