// @effect-diagnostics nodeBuiltinImport:off -- Fixtures exercise real Git and inspect the exact binary index.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { exportGitSnapshot, importGitSnapshot } from "./machineHandoffGit.ts";

const { execFileSync } = NodeChildProcess;
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function fixture(isolated = false, largeUnchanged = false) {
  const root = mkdtempSync(join(tmpdir(), "t3-machine-handoff-test-"));
  let source = join(root, "source");
  const destination = join(root, "destination");
  git(root, "init", source);
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.test");
  writeFileSync(join(source, "file"), "base\n");
  writeFileSync(join(source, "deleted"), "delete me\n");
  writeFileSync(join(source, "unstaged-deleted"), "remove from worktree\n");
  if (largeUnchanged)
    writeFileSync(join(source, "unchanged-large"), Buffer.alloc(65 * 1024 * 1024));
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(root, "clone", source, destination);
  git(source, "update-ref", "refs/remotes/origin/main", git(source, "rev-parse", "HEAD"));
  writeFileSync(join(source, "unpushed"), "local commit\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "unpushed");
  if (isolated) {
    const worktree = join(root, "source-worktree");
    git(source, "worktree", "add", "--detach", worktree, "HEAD");
    source = worktree;
  }
  writeFileSync(join(source, "file"), "staged\n");
  git(source, "add", "file");
  writeFileSync(join(source, "file"), "unstaged\n");
  chmodSync(join(source, "file"), 0o755);
  git(source, "update-index", "--force-remove", "deleted");
  NodeFS.renameSync(join(source, "unstaged-deleted"), join(root, "removed"));
  writeFileSync(join(source, "binary"), Buffer.from([0, 255, 3, 0]));
  return { root, source, destination };
}

describe("machine Git handoff", () => {
  it.each([false, true])(
    "preserves unpushed history and separate index/worktree states without touching source (isolated=%s)",
    async (isolated) => {
      const { root, source, destination } = fixture(isolated);
      const head = git(source, "rev-parse", "HEAD");
      const indexPath = git(source, "rev-parse", "--path-format=absolute", "--git-path", "index");
      const index = readFileSync(indexPath);
      const status = git(source, "status", "--porcelain=v1");
      const snapshot = await exportGitSnapshot(source);
      const target = join(root, "imported");
      await importGitSnapshot(destination, target, snapshot);
      expect(git(target, "rev-parse", "HEAD")).toBe(head);
      expect(git(target, "show", ":file")).toBe("staged");
      expect(readFileSync(join(target, "file"), "utf8")).toBe("unstaged\n");
      expect(readFileSync(join(target, "binary"))).toEqual(Buffer.from([0, 255, 3, 0]));
      expect(git(target, "status", "--porcelain=v1")).toBe(status);
      expect(git(source, "rev-parse", "HEAD")).toBe(head);
      expect(readFileSync(indexPath)).toEqual(index);
      expect(git(source, "status", "--porcelain=v1")).toBe(status);
      expect(git(source, "stash", "list")).toBe("");
    },
  );

  it("transfers a small dirty handoff when unchanged tracked assets exceed the dirty byte limit", async () => {
    const { root, source, destination } = fixture(false, true);
    const snapshot = await exportGitSnapshot(source);
    const target = join(root, "large-import");
    await importGitSnapshot(destination, target, snapshot);
    expect(NodeFS.statSync(join(target, "unchanged-large")).size).toBe(65 * 1024 * 1024);
    expect(git(target, "status", "--porcelain=v1")).toBe(git(source, "status", "--porcelain=v1"));
    writeFileSync(join(source, "too-large-dirty"), Buffer.alloc(65 * 1024 * 1024));
    await expect(exportGitSnapshot(source)).rejects.toThrow("working-file byte limit");
  });

  it("explains missing destination history before creating a worktree", async () => {
    const { root, source, destination } = fixture();
    git(source, "update-ref", "refs/remotes/origin/main", git(destination, "rev-parse", "HEAD"));
    const snapshot = await exportGitSnapshot(source);
    const empty = join(root, "empty");
    git(root, "init", empty);
    const target = join(root, "missing-history");
    await expect(importGitSnapshot(empty, target, snapshot)).rejects.toThrow("Clone or fetch");
    expect(NodeFS.existsSync(target)).toBe(false);
  });

  it("refuses an existing target and invalid bundles without changing the source or target", async () => {
    const { source, destination, root } = fixture();
    const snapshot = await exportGitSnapshot(source);
    const before = git(destination, "status", "--porcelain=v1");
    await expect(importGitSnapshot(destination, destination, snapshot)).rejects.toThrow("exists");
    await expect(
      importGitSnapshot(destination, join(root, "bad"), { ...snapshot, bundle: "AAAA" }),
    ).rejects.toThrow();
    expect(git(destination, "status", "--porcelain=v1")).toBe(before);
  });

  it("preserves committed, staged, and untracked in-repository symlinks without dereferencing", async () => {
    const { root, source, destination } = fixture();
    mkdirSync(join(source, ".claude"));
    mkdirSync(join(source, ".agents"));
    writeFileSync(join(source, ".agents", "skill"), "owned skill\n");
    symlinkSync("../.agents", join(source, ".claude", "skills"));
    git(source, "add", ".claude", ".agents");
    git(source, "commit", "-m", "repository skill link");
    symlinkSync("file", join(source, "staged-link"));
    git(source, "add", "staged-link");
    symlinkSync(".agents", join(source, "untracked-link"));
    const submodule = join(root, "submodule");
    git(root, "init", submodule);
    git(submodule, "config", "user.name", "Test");
    git(submodule, "config", "user.email", "test@example.test");
    writeFileSync(join(submodule, "nested"), "submodule content\n");
    git(submodule, "add", ".");
    git(submodule, "commit", "-m", "submodule revision");
    git(source, "-c", "protocol.file.allow=always", "submodule", "add", submodule, "vendor");
    git(source, "commit", "-m", "clean submodule");
    const before = git(source, "status", "--porcelain=v1");
    const snapshot = await exportGitSnapshot(source);
    const target = join(root, "with-links");
    await importGitSnapshot(destination, target, snapshot);
    expect(NodeFS.readlinkSync(join(target, ".claude", "skills"))).toBe("../.agents");
    expect(NodeFS.readlinkSync(join(target, "staged-link"))).toBe("file");
    expect(NodeFS.readlinkSync(join(target, "untracked-link"))).toBe(".agents");
    expect(git(target, "ls-files", "--stage", "staged-link")).toMatch(/^120000 /);
    expect(git(target, "ls-files", "--stage", "vendor")).toBe(
      git(source, "ls-files", "--stage", "vendor"),
    );
    expect(NodeFS.statSync(join(target, "vendor")).isDirectory()).toBe(true);
    expect(NodeFS.existsSync(join(target, "vendor", "nested"))).toBe(false);
    expect(git(target, "status", "--porcelain=v1")).toBe(before);
    expect(git(source, "status", "--porcelain=v1")).toBe(before);
    writeFileSync(join(source, "vendor", "nested"), "dirty submodule\n");
    await expect(exportGitSnapshot(source)).rejects.toThrow("submodules");
  });

  it.each(["/outside", "../outside", "file/../../outside", ".git/config"])(
    "refuses unsafe symlink target %s without dereferencing it",
    async (target) => {
      const { source } = fixture();
      symlinkSync(target, join(source, "link"));
      await expect(exportGitSnapshot(source)).rejects.toThrow("symlink target");
      git(source, "add", "link");
      git(source, "commit", "-m", "unsafe link");
      await expect(exportGitSnapshot(source)).rejects.toThrow("symlink target");
    },
  );

  it("refuses repository subprojects instead of silently losing their working directory", async () => {
    const { source } = fixture();
    const subproject = join(source, "subproject");
    mkdirSync(subproject);
    await expect(exportGitSnapshot(subproject)).rejects.toThrow("repository-root");
  });

  it("refuses unmerged and special-index states before exporting", async () => {
    const { source } = fixture();
    git(source, "update-index", "--assume-unchanged", "file");
    await expect(exportGitSnapshot(source)).rejects.toThrow("index");
  });
});
